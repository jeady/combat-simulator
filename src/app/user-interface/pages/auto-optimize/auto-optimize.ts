import './auto-optimize.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';
import { PageController, PageId } from 'src/app/user-interface/pages/page-controller';
import { Settings, SettingsController } from 'src/app/settings-controller';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { multiStart, MultiStartProgress, Seed } from 'src/app/optimizer/multistart';
import { MemoizingScorer, stableStringify } from 'src/app/optimizer/cache';
import { WorkerPool } from 'src/app/optimizer/worker-pool';
import { createWorkerPool } from 'src/app/optimizer/worker-pool-factory';
import { AttackTypeConstraint } from 'src/app/optimizer/weapon-rules';
import { ItemPool } from 'src/app/stores/optimizer.store';
import {
    agilityDimensions,
    cartographyDimensions,
    GameCandidateProvider,
    GameLoadoutApplier,
    GameScorer,
    buildDimensions,
    getSelectedTarget,
    isSupportedObjective,
    isSupportedTarget,
    slayerTaskTargetId
} from 'src/app/optimizer/adapters';
import {
    CancelToken,
    DEFAULT_OPTIONS,
    Dimension,
    DimensionChoice,
    OptimizeEvent,
    OptimizeOptions,
    OptimizePhase,
    OptimizeProgress,
    OptimizeResult,
    OptimizeTarget
} from 'src/app/optimizer/types';
import { choicesToLoadout, LiveLoadoutGrid, loadoutRow, RenderedLoadout } from './loadout-view';
import { Lookup } from 'src/shared/utils/lookup';

// Injected at build time by webpack DefinePlugin (see webpack.config.ts) so the page can show which
// build is actually loaded — the surest way to confirm a freshly built modfile took effect.
declare const __MCS_BUILD__: string;

declare global {
    interface HTMLElementTagNameMap {
        'mcs-auto-optimize': AutoOptimizePage;
    }
}

/** One scored setup, kept for the leaderboard (keyed by its serialized choice list). */
interface LeaderEntry {
    key: string;
    choices: DimensionChoice[];
    metric: number;
    deathRate: number;
    feasible: boolean;
    /** Standard error of {@link metric}, if the scorer estimated it; used for the noise-tie `≈` marker. */
    stdError?: number;
}

/**
 * Wrap a dimension so the optimizer never varies it — its single choice is "stay as-is", so the
 * inner search skips it. It still appears in the aligned choice list (so the live grid renders the
 * locked slot's real item), it just never changes. This is how the "lock a slot" control works.
 */
function lockedDimension(dim: Dimension): Dimension {
    return { ...dim, getCandidates: () => [] };
}

/**
 * mulberry32 — a tiny, fast, well-distributed seeded PRNG (returns a function yielding floats in
 * [0,1)). Seeded so a run's random restart loadouts are reproducible from its start time, matching the
 * seeded-RNG style the optimizer tests use rather than `Math.random`.
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Minimum gap between live-view repaints (~2/sec). Candidate evaluations arrive far faster than that
 * — and in bursts under parallel workers (a whole batch lands at once) — so the "currently evaluating"
 * grid + leaderboard sample the most recent candidate at this cadence instead of repainting per event.
 */
const LIVE_RENDER_INTERVAL_MS = 500;

@LoadTemplate('app/user-interface/pages/auto-optimize/auto-optimize.html')
export class AutoOptimizePage extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _objective: HTMLDivElement;
    private readonly _searchTrials: HTMLInputElement;
    private readonly _fastSearch: HTMLInputElement;
    private readonly _restarts: HTMLSelectElement;
    private readonly _progression: HTMLInputElement;
    private readonly _attackType: HTMLSelectElement;
    private readonly _itemPool: HTMLSelectElement;
    private readonly _run: HTMLButtonElement;
    private readonly _apply: HTMLButtonElement;
    private readonly _status: HTMLDivElement;
    private readonly _progress: HTMLDivElement;
    private readonly _results: HTMLDivElement;
    private readonly _build: HTMLDivElement;

    private readonly _locks: HTMLDivElement;
    private readonly _searchAll: HTMLButtonElement;
    private readonly _lockAll: HTMLButtonElement;

    private readonly _livePanel: HTMLDivElement;
    private readonly _liveTitle: HTMLDivElement;
    private readonly _liveCaption: HTMLDivElement;
    private readonly _liveGridHost: HTMLDivElement;
    private readonly _feedPanel: HTMLDivElement;
    private readonly _feed: HTMLDivElement;
    private readonly _leaderboardPanel: HTMLDivElement;
    private readonly _leaderboard: HTMLDivElement;

    private readonly _progressBar: HTMLDivElement;
    private readonly _progressBarFill: HTMLDivElement;
    private readonly _progressEta: HTMLDivElement;
    private readonly _baseCaption: HTMLDivElement;
    private readonly _baseGridHost: HTMLDivElement;

    /** Pool-less scorer used only for objective-direction display (isMaximize); the run builds its own. */
    private readonly _scorer = new GameScorer();
    private _cancel?: CancelToken;
    private _result?: OptimizeResult;

    /** Reused pool of parallel sim workers (built lazily; rebuilt when the worker count changes). */
    private _pool?: WorkerPool;
    private _poolSize = 0;

    /** Dimension ids the user has locked (excluded from the search). */
    private readonly _lockedDims = new Set<string>();
    /** Dimensions used for the current/last run, for rendering aligned choice lists. */
    private _runDims: Dimension[] = [];

    private _liveGrid?: LiveLoadoutGrid;
    /** The "Current setup" grid (the user's equipped gear at the start of the run). */
    private _baseGrid?: LiveLoadoutGrid;
    /** Baseline loadout, for the "Current setup" panel and diff-highlighting in the feed/leaderboard. */
    private _baselineLoadout?: RenderedLoadout;
    private readonly _leaderboardMap = new Map<string, LeaderEntry>();
    private _latest?: OptimizeEvent;
    /** The most recent best-improved event, used to render the winning loadout when the run finishes. */
    private _bestEvent?: OptimizeEvent;
    /** Wall-clock of the last live-view repaint + a pending trailing-repaint timer (see _scheduleRender). */
    private _lastRenderAt = 0;
    private _renderTimer?: number;
    /** PageController page-change subscription, kept so disconnectedCallback can unregister it. */
    private _onPage?: (id: PageId) => void;
    private _leaderboardSig = '';
    /** Progress-bar/ETA bookkeeping: rough total-evaluation estimate + run start time. */
    private _estimatedEvals = 1;
    private _startTime = 0;
    /**
     * Per-pass eval estimate + max passes, kept so the denominator can be rescaled once a pass finishes:
     * remaining passes may not run (early convergence), so after pass P we set the total to
     * evalsSoFar + (remaining passes × perPass) rather than trusting the up-front candidates × maxPasses.
     */
    private _perPassEvals = 1;
    private _maxPasses = DEFAULT_OPTIONS.maxPasses;
    /** Highest pass number seen from progress ticks, to detect a pass boundary and rescale once. */
    private _lastPass = 0;

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-auto-optimize-page-template'));

        this._objective = getElementFromFragment(this._content, 'mcs-auto-optimize-objective', 'div');
        this._searchTrials = getElementFromFragment(this._content, 'mcs-auto-optimize-search-trials', 'input');
        this._fastSearch = getElementFromFragment(this._content, 'mcs-auto-optimize-fast-search', 'input');
        this._restarts = getElementFromFragment(this._content, 'mcs-auto-optimize-restarts', 'select');
        this._progression = getElementFromFragment(this._content, 'mcs-auto-optimize-progression', 'input');
        this._attackType = getElementFromFragment(this._content, 'mcs-auto-optimize-attack-type', 'select');
        this._itemPool = getElementFromFragment(this._content, 'mcs-auto-optimize-item-pool', 'select');
        this._run = getElementFromFragment(this._content, 'mcs-auto-optimize-run', 'button');
        this._apply = getElementFromFragment(this._content, 'mcs-auto-optimize-apply', 'button');
        this._status = getElementFromFragment(this._content, 'mcs-auto-optimize-status', 'div');
        this._progress = getElementFromFragment(this._content, 'mcs-auto-optimize-progress', 'div');
        this._results = getElementFromFragment(this._content, 'mcs-auto-optimize-results', 'div');
        this._build = getElementFromFragment(this._content, 'mcs-auto-optimize-build', 'div');

        this._locks = getElementFromFragment(this._content, 'mcs-auto-optimize-locks', 'div');
        this._searchAll = getElementFromFragment(this._content, 'mcs-auto-optimize-search-all', 'button');
        this._lockAll = getElementFromFragment(this._content, 'mcs-auto-optimize-lock-all', 'button');

        this._livePanel = getElementFromFragment(this._content, 'mcs-auto-optimize-live', 'div');
        this._liveTitle = getElementFromFragment(this._content, 'mcs-auto-optimize-live-title', 'div');
        this._liveCaption = getElementFromFragment(this._content, 'mcs-auto-optimize-live-caption', 'div');
        this._liveGridHost = getElementFromFragment(this._content, 'mcs-auto-optimize-live-grid', 'div');
        this._feedPanel = getElementFromFragment(this._content, 'mcs-auto-optimize-feed-panel', 'div');
        this._feed = getElementFromFragment(this._content, 'mcs-auto-optimize-feed', 'div');
        this._leaderboardPanel = getElementFromFragment(this._content, 'mcs-auto-optimize-leaderboard-panel', 'div');
        this._leaderboard = getElementFromFragment(this._content, 'mcs-auto-optimize-leaderboard', 'div');

        this._progressBar = getElementFromFragment(this._content, 'mcs-auto-optimize-progressbar', 'div');
        this._progressBarFill = getElementFromFragment(this._content, 'mcs-auto-optimize-progressbar-fill', 'div');
        this._progressEta = getElementFromFragment(this._content, 'mcs-auto-optimize-eta', 'div');
        this._baseCaption = getElementFromFragment(this._content, 'mcs-auto-optimize-base-caption', 'div');
        this._baseGridHost = getElementFromFragment(this._content, 'mcs-auto-optimize-base-grid', 'div');
    }

    public disconnectedCallback() {
        // Free the pool's workers if the page element is ever torn down (the base single worker,
        // owned by Global.simulation, is unaffected), and cancel any pending live-view repaint.
        this._teardownPool();
        if (this._renderTimer !== undefined) {
            clearTimeout(this._renderTimer);
            this._renderTimer = undefined;
        }
        // PageController keeps callbacks in a static Set, so a stale one would leak (and fire against a
        // torn-down element) until the page is rebuilt. Unregister the exact reference we stored.
        if (this._onPage) {
            PageController.off(this._onPage);
            this._onPage = undefined;
        }
    }

    public connectedCallback() {
        this.appendChild(this._content);

        // __MCS_BUILD__ is a build-time literal (webpack DefinePlugin) — no runtime Global access, so
        // this is safe even though connectedCallback can run during setup before Global.context exists.
        this._build.textContent = `Build: ${__MCS_BUILD__}`;

        this._searchTrials.value = String(Global.stores.optimizer.state.searchTrials);
        this._fastSearch.checked = Global.stores.optimizer.state.fastSearch;
        this._fastSearch.onchange = () => Global.stores.optimizer.set({ fastSearch: this._fastSearch.checked });
        this._restarts.value = String(Global.stores.optimizer.state.restarts);
        this._restarts.onchange = () =>
            Global.stores.optimizer.set({ restarts: Math.max(1, parseInt(this._restarts.value, 10) || 1) });
        this._progression.checked = Global.stores.optimizer.state.optimizeProgression;
        this._progression.onchange = () =>
            Global.stores.optimizer.set({ optimizeProgression: this._progression.checked });
        this._attackType.value = Global.stores.optimizer.state.attackTypeConstraint;
        this._attackType.onchange = () =>
            Global.stores.optimizer.set({ attackTypeConstraint: this._attackType.value as AttackTypeConstraint });
        this._itemPool.value = Global.stores.optimizer.state.itemPool;
        this._itemPool.onchange = () => Global.stores.optimizer.set({ itemPool: this._itemPool.value as ItemPool });
        this._run.onclick = () => this._onRun();
        this._apply.onclick = () => this._onApply();

        this._searchAll.onclick = () => {
            this._lockedDims.clear();
            this._renderLocks();
        };
        this._lockAll.onclick = () => {
            for (const dim of this._buildDisplayDimensions()) {
                this._lockedDims.add(dim.id);
            }
            this._renderLocks();
        };

        this._onPage = id => {
            if (id === PageId.AutoOptimize) {
                this._refreshObjective();
                this._renderLocks();
            }
        };
        PageController.on(this._onPage);

        this._refreshObjective();
        this._renderLocks();
    }

    /** Show the current objective + target (read live from the Simulate page selections). */
    private _refreshObjective() {
        const plot = Global.stores.plotter.plotType;
        const target = getSelectedTarget();
        const targetName = this._targetName(target);
        // plot.text already ends with "per" for time metrics (e.g. "XP per"), so only append the unit.
        const unit = plot.isTime ? ` ${Global.stores.plotter.timeShorthand}` : '';
        const direction = this._scorer.isMaximize() ? 'maximize' : 'minimize';
        const supported = isSupportedObjective();
        const targetSupported = isSupportedTarget(target);

        // A setup "passes" the survival constraint by never dying across the (low) search-trial count,
        // but that's a sample: the true death rate can still be non-zero. The one-sided 95% upper bound
        // for observing zero deaths in N trials is ~3/N (the rule of three), so surface it honestly.
        const searchTrials = Math.max(1, Global.stores.optimizer.state.searchTrials);
        const trueRate = ((3 / searchTrials) * 100).toFixed(1);

        this._objective.innerHTML = `
            <div><strong>Objective:</strong> ${plot.text}${unit} (${direction})</div>
            <div><strong>Target:</strong> ${targetName}</div>
            <div class="text-muted">Survival constraint: no deaths tolerated (checked over ${searchTrials} search trials — a setup passing this can still have a true death rate up to ~${trueRate}%).</div>
            ${
                supported
                    ? ''
                    : `<div class="mcs-auto-optimize-warn">This metric isn't supported by auto-optimize yet. Pick e.g. Kills, an XP type, Death Rate, or Kill Time on the Simulate page.</div>`
            }
            ${
                target && !targetSupported
                    ? `<div class="mcs-auto-optimize-warn">You can't reach any monster in this slayer task with your current setup, so there's nothing to optimize. Pick a different task or target on the Simulate page.</div>`
                    : ''
            }
        `;
    }

    /** Human-readable name for the selected target — a monster, or a named slayer-task tier. */
    private _targetName(target: OptimizeTarget | undefined): string {
        if (!target) {
            return 'None selected';
        }
        const taskId = slayerTaskTargetId(target);
        if (taskId) {
            return `${Lookup.tasks.getObjectByID(taskId)?.name ?? taskId} (slayer task)`;
        }
        return Global.game.monsters.getObjectByID(target.monsterId)?.name ?? target.monsterId;
    }

    /** Fresh dimensions reflecting the current config (for the lock panel + run). */
    private _buildDisplayDimensions(): Dimension[] {
        const applier = new GameLoadoutApplier();
        const { itemPool, attackTypeConstraint } = Global.stores.optimizer.state;
        return buildDimensions(applier, new GameCandidateProvider(itemPool, attackTypeConstraint), {
            ownedOnly: itemPool !== 'all'
        });
    }

    /** Render the lock panel: one row per dimension with a "search this" checkbox + current icon. */
    private _renderLocks() {
        const dims = this._buildDisplayDimensions();
        this._locks.innerHTML = '';

        for (const dim of dims) {
            const locked = this._lockedDims.has(dim.id);
            const row = createElement('div', { classList: ['mcs-auto-optimize-lock-row'] });
            row.classList.toggle('mcs-ao-locked', locked);

            const checkbox = createElement('input', { attributes: [['type', 'checkbox']] });
            checkbox.checked = !locked;
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    this._lockedDims.delete(dim.id);
                } else {
                    this._lockedDims.add(dim.id);
                }
                row.classList.toggle('mcs-ao-locked', !checkbox.checked);
            };

            // Current choice as a small icon (empty slots/consumables simply render no icon).
            const icon = loadoutRow(choicesToLoadout([dim], [dim.getCurrentChoice()]));
            const label = createElement('label', { text: dim.label });
            label.onclick = () => checkbox.click();

            row.append(checkbox, icon, label);
            this._locks.appendChild(row);
        }
    }

    private async _onRun() {
        // Second click while running = cancel.
        if (Global.stores.optimizer.state.isRunning) {
            if (this._cancel) {
                this._cancel.cancelled = true;
            }
            this._run.disabled = true;
            this._status.textContent = 'Cancelling after the current evaluation…';
            return;
        }

        if (!isSupportedObjective()) {
            this._status.textContent =
                "The selected plot metric isn't supported for auto-optimize yet. Choose Kills, an XP type, Death Rate, etc.";
            return;
        }

        const target = getSelectedTarget();
        if (!target) {
            this._status.textContent = 'No target selected. Open the Simulate page and select a monster first.';
            return;
        }

        if (!isSupportedTarget(target)) {
            this._status.textContent =
                "You can't reach any monster in this slayer task with your current setup, so there's nothing to optimize. Pick a different task or target on the Simulate page.";
            return;
        }

        if (Global.stores.simulator.state.isRunning) {
            this._status.textContent = 'A simulation is currently running. Wait for it to finish, then try again.';
            return;
        }

        const searchTrials = Math.max(1, parseInt(this._searchTrials.value, 10) || 200);
        const fastSearch = this._fastSearch.checked;
        const restarts = Math.max(1, parseInt(this._restarts.value, 10) || 1);
        Global.stores.optimizer.set({ searchTrials, fastSearch, restarts });

        const cancel: CancelToken = { cancelled: false };
        this._cancel = cancel;
        this._result = undefined;
        this._apply.disabled = true;
        this._results.innerHTML = '';
        this._progress.textContent = '';
        this._resetLiveFeedback();
        Global.stores.optimizer.set({ isRunning: true });
        this._run.textContent = 'Cancel';
        this._status.textContent = 'Running…';

        // Stand up (or reuse) the parallel worker pool. If workers > 1 this fans candidate sims across
        // N workers; 1/auto-resolving-to-1 keeps the single-worker path. init loads game data into each
        // worker, so it can take a moment the first time — surface that in the status line.
        const workerCount = this._resolveWorkerCount();
        let pool: WorkerPool | undefined;
        if (workerCount > 1) {
            this._status.textContent = `Starting ${workerCount} sim workers…`;
            pool = await this._ensurePool(workerCount);
        } else {
            this._teardownPool();
        }
        // The pool init above is awaited, so the user may have cancelled meanwhile; the optimizer
        // checks the token immediately and exits fast, and the finally below restores UI state.
        this._status.textContent = 'Running…';

        const applier = new GameLoadoutApplier();
        // Score with batch-means variance, then memoize. GameScorer splits each evaluation into B
        // sub-runs *inside a single worker call* to estimate the metric's standard error (which the
        // optimizer's significance gate uses to avoid recommending noise-level swaps), so the heavy
        // save decode is paid once per evaluation, not once per batch. When a pool is present it also
        // exposes the parallel evaluateBatch path (candidates simmed concurrently). The cache wraps it
        // (keyed by the applied Settings snapshot) so convergence-pass repeats are served without
        // re-simming — including a per-setup key so the parallel path is cached too.
        const scorer = new MemoizingScorer(
            new GameScorer(5, 5, pool),
            () => stableStringify(applier.snapshot()),
            setup => stableStringify(setup)
        );
        // Keep every dimension in the array (so locked slots still render in the live grid); locked
        // ones are wrapped so the search never varies them. `preRankTopK` (default 0 = off) narrows
        // each equipment slot to its top-K analytic candidates before any real sim runs.
        const preRankTopK = Global.stores.optimizer.state.preRankTopK;
        const attackTypeConstraint = Global.stores.optimizer.state.attackTypeConstraint;
        const itemPool = Global.stores.optimizer.state.itemPool;
        // Consumables (food/potion/summons) follow the same pool at the coarse owned-vs-all level:
        // 'owned' and 'craftable' keep them owned-only (craftability is a gear concept), 'all' opens
        // them up. Equipment gets the full tri-state via the candidate provider.
        this._runDims = buildDimensions(applier, new GameCandidateProvider(itemPool, attackTypeConstraint), {
            preRankTopK,
            ownedOnly: itemPool !== 'all'
        }).map(dim => (this._lockedDims.has(dim.id) ? lockedDimension(dim) : dim));
        // Estimate total work up front (candidates × passes) to drive the progress bar + ETA. With
        // restarts, the same search runs once per seed, so the denominator scales by the seed count.
        this._estimatedEvals = this._estimateEvals() * restarts;
        this._startTime = Date.now();
        const optimizer = new CoordinateAscentOptimizer(scorer, this._runDims, applier);
        const sim = Global.stores.simulator.state;

        const runOptions = {
            searchTrials,
            // Ticks are the per-kill budget, not a "search is cheaper" knob — cutting them below the
            // user's Simulate setting starves slow kills and fails every sim (baseline included) for
            // any target that needs >searchTicks to die. Speed comes from fewer trials; never let the
            // search tick budget drop below sim.ticks.
            searchTicks: Math.max(Global.stores.optimizer.state.searchTicks, sim.ticks),
            finalTrials: sim.trials,
            finalTicks: sim.ticks,
            // Fast search: screen every candidate at a quarter of the search trials, then confirm only
            // the best few at full trials. The optimizer skips the screen pass automatically for slots
            // that have ≤ screenKeep candidates (no benefit there).
            screenTrials: fastSearch ? Math.max(10, Math.floor(searchTrials / 4)) : 0,
            screenKeep: 3
        };

        try {
            // Single-start (restarts === 1) is today's exact behavior: one greedy search from the
            // user's current gear, driven straight by optimizer.run. Multiple restarts re-run the same
            // search from randomized starting loadouts (multiStart) and keep the best — escaping cold-
            // start local optima at ~N× the time. We deliberately keep the 1-seed case OFF the
            // multiStart path so its behavior stays byte-identical.
            let result: OptimizeResult;
            if (restarts === 1) {
                result = await optimizer.run(
                    target,
                    runOptions,
                    progress => this._renderProgress(progress),
                    cancel,
                    event => this._onEvent(event)
                );
            } else {
                const seeds = this._buildSeeds(applier, restarts);
                const multi = await multiStart(
                    optimizer,
                    applier,
                    scorer,
                    target,
                    seeds,
                    runOptions,
                    progress => this._onSeedProgress(progress),
                    cancel,
                    progress => this._renderProgress(progress),
                    event => this._onEvent(event)
                );
                result = multi.best;
            }
            // Staged progression pass (opt-in): once the gear/consumable search has a usable result,
            // tune agility + cartography ON TOP of the best gear. Runs only if there's something to do.
            if (
                Global.stores.optimizer.state.optimizeProgression &&
                !cancel.cancelled &&
                Number.isFinite(result.baselineMetric)
            ) {
                result = await this._runProgressionPass(applier, scorer, target, runOptions, cancel, result);
            }
            this._result = result;
            Global.stores.optimizer.set({ result });
            this._renderResult(result);
        } catch (error) {
            this._status.textContent = `Optimization failed: ${(error as Error)?.message ?? String(error)}`;
            Global.logger.error('Auto-optimize failed', error);
        } finally {
            Global.stores.optimizer.set({ isRunning: false });
            this._cancel = undefined;
            this._run.disabled = false;
            this._run.textContent = 'Run Optimization';
        }
    }

    /**
     * Second, staged optimization pass: tune character-progression combat levers — the agility course
     * for the target's realm and the cartography Point of Interest — on top of the best gear the main
     * search found. Reuses the same optimizer engine, scorer (cache/pool), and run options — just a
     * different Dimension[]. Returns a MERGED result (original baseline → best gear + best progression,
     * with both diffs concatenated). No-ops back to `gearResult` when there's nothing to tune (no realm,
     * no unlocked obstacle slots, no discovered stat-POI). Deliberately runs without the live-event
     * callback: these choices don't map onto the equipment paper-doll, so the live grid/feed stay on
     * the gear result while a "Optimizing agility & cartography…" status + progress bar convey the phase.
     */
    private async _runProgressionPass(
        applier: GameLoadoutApplier,
        scorer: MemoizingScorer,
        target: OptimizeTarget,
        runOptions: Partial<OptimizeOptions>,
        cancel: CancelToken,
        gearResult: OptimizeResult
    ): Promise<OptimizeResult> {
        const monster = Global.game.monsters.getObjectByID(target.monsterId);
        const realmId = monster ? Global.game.getMonsterArea(monster).realm?.id : undefined;

        // Tune progression on the winning build: apply the best gear before searching.
        applier.restore(gearResult.bestSetup);
        const progressionDims = [...(realmId ? agilityDimensions(realmId) : []), ...cartographyDimensions()];
        if (progressionDims.length === 0) {
            applier.restore(gearResult.baselineSetup); // nothing to do — leave the user's setup as it was
            return gearResult;
        }

        const gearDims = this._runDims;
        this._status.textContent = 'Optimizing agility & cartography…';
        this._runDims = progressionDims;
        this._estimatedEvals = this._estimateEvals();
        this._startTime = Date.now();

        const progressionResult = await new CoordinateAscentOptimizer(scorer, progressionDims, applier).run(
            target,
            runOptions,
            progress => this._renderProgress(progress),
            cancel
        );

        // Restore the user's original setup (the gear run's finally restored it before we applied best
        // gear; this run's finally left best-gear+current-progression) and the gear dims for render.
        applier.restore(gearResult.baselineSetup);
        this._runDims = gearDims;

        // Merge: original baseline → best gear + best progression, diffs concatenated.
        return {
            status: progressionResult.status,
            baselineSetup: gearResult.baselineSetup,
            bestSetup: progressionResult.bestSetup,
            baselineMetric: gearResult.baselineMetric,
            baselineDeathRate: gearResult.baselineDeathRate,
            bestMetric: progressionResult.bestMetric,
            bestDeathRate: progressionResult.bestDeathRate,
            // The best setup is the progression run's winner, so its feasibility is that run's.
            bestFeasible: progressionResult.bestFeasible,
            dimensionDiff: [...gearResult.dimensionDiff, ...progressionResult.dimensionDiff],
            evaluations: gearResult.evaluations + progressionResult.evaluations,
            improved: gearResult.improved || progressionResult.improved
        };
    }

    /**
     * Build the restart seeds for multiStart, all as opaque `applier.snapshot()` tokens.
     *  - Seed 0 is the user's setup as-is (`current`) — so a multi-start never does worse than today's
     *    single start (that basin is always one of the seeds).
     *  - Each remaining seed randomizes every UNLOCKED dimension to a uniformly-random candidate, giving
     *    the search a different starting basin. Locked dimensions (wrapped to expose no candidates) are
     *    left untouched, as are dimensions with no candidates. Conflict resolution is the appliers' job,
     *    exactly as during the search itself.
     * The RNG is seeded from the run's start time so a run is reproducible. We restore the user's setup
     * between seed constructions so each `random-i` is built from the same clean starting point, then
     * restore it once more at the end (multiStart re-installs each seed itself before optimizing).
     */
    private _buildSeeds(applier: GameLoadoutApplier, restarts: number): Seed[] {
        const original = applier.snapshot();
        const rng = mulberry32(this._startTime >>> 0);
        const seeds: Seed[] = [{ id: 'current', label: 'Current setup', snapshot: applier.snapshot() }];

        for (let i = 1; i < restarts; i++) {
            applier.restore(original);
            for (const dim of this._runDims) {
                const candidates = dim.getCandidates();
                if (candidates.length === 0) {
                    continue; // locked slots and empty dimensions stay as the user's setup
                }
                dim.applyChoice(candidates[Math.floor(rng() * candidates.length)]);
            }
            seeds.push({ id: `random-${i}`, label: `Random start ${i}`, snapshot: applier.snapshot() });
        }

        // multiStart snapshots the user's setup itself and restores it in its finally, but leave the
        // world exactly as we found it here so nothing downstream sees the last random loadout.
        applier.restore(original);
        return seeds;
    }

    /** Surface which restart is running, e.g. "Restart 2/3 …", while multiStart works through seeds. */
    private _onSeedProgress(progress: MultiStartProgress) {
        this._status.textContent = `Restart ${progress.seedIndex}/${progress.seedCount} …`;
    }

    private _onApply() {
        if (!this._result || !this._result.improved) {
            return;
        }

        // bestSetup is the full winning configuration (a Settings snapshot); apply it directly.
        SettingsController.import(this._result.bestSetup as Settings);

        this._status.textContent = 'Applied the best setup to your configuration.';
        this._apply.disabled = true;
        this._renderLocks();
    }

    /** Clear and show the live-feedback panels for a fresh run. */
    private _resetLiveFeedback() {
        // Cancel a pending trailing repaint from a prior run and reset the throttle so this run's first
        // event (the baseline) paints immediately.
        if (this._renderTimer !== undefined) {
            clearTimeout(this._renderTimer);
            this._renderTimer = undefined;
        }
        this._lastRenderAt = 0;
        this._leaderboardMap.clear();
        this._leaderboardSig = '';
        this._latest = undefined;
        this._bestEvent = undefined;
        this._baselineLoadout = undefined;
        this._feed.innerHTML = '';
        this._leaderboard.innerHTML = '';
        this._liveTitle.textContent = 'Currently evaluating';
        this._liveCaption.textContent = '';
        this._liveGridHost.innerHTML = '';
        this._liveGrid = new LiveLoadoutGrid();
        this._liveGridHost.appendChild(this._liveGrid.element);

        this._baseCaption.textContent = '';
        this._baseGridHost.innerHTML = '';
        this._baseGrid = new LiveLoadoutGrid();
        this._baseGridHost.appendChild(this._baseGrid.element);

        this._progressBar.style.display = '';
        this._progressBarFill.style.width = '0%';
        this._progressEta.textContent = '';

        this._livePanel.style.display = '';
        this._feedPanel.style.display = '';
        this._leaderboardPanel.style.display = '';
    }

    /** Fold one optimizer event into the leaderboard + live state, scheduling a coalesced repaint. */
    private _onEvent(event: OptimizeEvent) {
        // The first event (changedIndex -1) is the baseline: the user's current setup + its score.
        if (event.changedIndex === -1 && !this._baselineLoadout) {
            this._baselineLoadout = choicesToLoadout(this._runDims, event.choices);
            this._baseGrid?.update(this._baselineLoadout);
            this._baseCaption.textContent = this._scoreCaption('Current', event);
        }

        const key = JSON.stringify(event.choices);
        const existing = this._leaderboardMap.get(key);
        if (!existing || this._directed(event.metric) > this._directed(existing.metric)) {
            this._leaderboardMap.set(key, {
                key,
                choices: event.choices,
                metric: event.metric,
                deathRate: event.deathRate,
                feasible: event.feasible,
                stdError: event.stdError
            });
        }

        this._latest = event;
        if (event.type === 'best-improved') {
            this._bestEvent = event;
            this._appendFeed(event);
        }
        this._scheduleRender();
    }

    /**
     * Throttle live-grid + leaderboard repaints to ~2/sec. Events can be very bursty — most of all with
     * parallel workers, where an entire batch of candidate results resolves at once — and repainting the
     * paper-doll grid + rebuilding the leaderboard on every event is wasted work that makes the page feel
     * sluggish. We render the most recent candidate immediately if enough time has passed, else schedule
     * a single trailing repaint at the interval boundary so the latest event is never dropped.
     */
    private _scheduleRender() {
        const now = Date.now();
        const elapsed = now - this._lastRenderAt;
        if (elapsed >= LIVE_RENDER_INTERVAL_MS) {
            if (this._renderTimer !== undefined) {
                clearTimeout(this._renderTimer);
                this._renderTimer = undefined;
            }
            this._lastRenderAt = now;
            this._flushRender();
        } else if (this._renderTimer === undefined) {
            this._renderTimer = window.setTimeout(() => {
                this._renderTimer = undefined;
                this._lastRenderAt = Date.now();
                this._flushRender();
            }, LIVE_RENDER_INTERVAL_MS - elapsed);
        }
    }

    private _flushRender() {
        if (this._latest && this._liveGrid) {
            const loadout = choicesToLoadout(this._runDims, this._latest.choices);
            const changedId =
                this._latest.changedIndex >= 0 ? this._runDims[this._latest.changedIndex]?.id : undefined;
            this._liveGrid.update(loadout, changedId);
            this._liveCaption.textContent = this._candidateCaption(this._latest);
            this._updateProgressBar(this._latest.evaluations, false);
        }
        this._renderLeaderboard();
    }

    private _candidateCaption(event: OptimizeEvent): string {
        const metric = Number.isFinite(event.metric) ? `${this._format(event.metric)}${this._metricUnit()}` : 'failed';
        const death = `${(event.deathRate * 100).toFixed(1)}% death`;
        const flag = event.feasible ? '' : ' · infeasible';
        return `trying ${metric} · ${death}${flag}`;
    }

    /** "Current: 1,234 /h · 0.0% death" (or "… · infeasible") for the baseline / current-setup panel. */
    private _scoreCaption(label: string, event: OptimizeEvent): string {
        const metric = Number.isFinite(event.metric) ? `${this._format(event.metric)}${this._metricUnit()}` : 'failed';
        const death = `${(event.deathRate * 100).toFixed(1)}% death`;
        const flag = event.feasible ? '' : ' · infeasible';
        return `${label}: ${metric} · ${death}${flag}`;
    }

    /** Append one "new best" row (compact icon strip + metric) to the feed. */
    private _appendFeed(event: OptimizeEvent) {
        const loadout = choicesToLoadout(this._runDims, event.choices);

        const entry = createElement('div', { classList: ['mcs-ao-entry'] });
        // Highlight every item that differs from the user's currently-equipped setup; show empty
        // slots as placeholders so slot positions stay fixed across rows.
        const row = loadoutRow(loadout, { diffFrom: this._baselineLoadout, showEmpty: true });
        const metric = createElement('div', {
            classList: ['mcs-ao-entry-metric'],
            text: `${this._format(event.metric)}${this._metricUnit()}`
        });
        entry.append(row, metric);
        this._feed.appendChild(entry);
        // Keep only the 5 most recent bests (which, since bests only improve, are the 5 best).
        while (this._feed.children.length > 5) {
            this._feed.firstElementChild?.remove();
        }
    }

    private _renderLeaderboard() {
        const entries = [...this._leaderboardMap.values()]
            .sort((a, b) => {
                if (a.feasible !== b.feasible) {
                    return a.feasible ? -1 : 1;
                }
                return this._directed(b.metric) - this._directed(a.metric);
            })
            .slice(0, 5);

        // Skip the (tooltip-rebuilding) repaint when the top-10 membership/order hasn't changed.
        const sig = entries.map(entry => entry.key).join('|');
        if (sig === this._leaderboardSig) {
            return;
        }
        this._leaderboardSig = sig;

        this._leaderboard.innerHTML = '';
        const leader = entries[0];
        entries.forEach((entry, index) => {
            const loadout = choicesToLoadout(this._runDims, entry.choices);
            const row = createElement('div', { classList: ['mcs-ao-entry'] });

            const rank = createElement('div', { classList: ['mcs-ao-entry-rank'], text: `#${index + 1}` });
            const icons = loadoutRow(loadout, { diffFrom: this._baselineLoadout, showEmpty: true });

            // Flag entries that trail #1 by less than a one-sided 95% band on the difference of the two
            // noisy estimates (1.645·√(se₁²+se₂²)): their gap is within simulation noise, so the ranking
            // between them isn't real. Skip #1 itself and any entry (or leader) missing a stdError.
            const withinNoise =
                index > 0 &&
                leader.stdError !== undefined &&
                entry.stdError !== undefined &&
                Number.isFinite(leader.metric) &&
                Number.isFinite(entry.metric) &&
                this._directed(leader.metric) - this._directed(entry.metric) <
                    1.645 * Math.hypot(leader.stdError, entry.stdError);

            const metricText = Number.isFinite(entry.metric) ? `${this._format(entry.metric)}${this._metricUnit()}` : '—';
            const death = entry.feasible ? '' : ` ☠${(entry.deathRate * 100).toFixed(0)}%`;
            const tie = withinNoise ? ' ≈' : '';
            const metric = createElement('div', {
                classList: entry.feasible ? ['mcs-ao-entry-metric'] : ['mcs-ao-entry-metric', 'mcs-ao-infeasible'],
                text: metricText + death + tie
            });
            if (withinNoise) {
                metric.title = 'within simulation noise of #1';
            }

            row.append(rank, icons, metric);
            this._leaderboard.appendChild(row);
        });
    }

    /** Directed score for ranking: bigger is better, respecting the objective's direction. */
    private _directed(metric: number): number {
        if (!Number.isFinite(metric)) {
            return -Infinity;
        }
        return this._scorer.isMaximize() ? metric : -metric;
    }

    /** The objective's time unit suffix (e.g. " /h"), or '' for non-time metrics. */
    private _metricUnit(): string {
        const plot = Global.stores.plotter.plotType;
        return plot.isTime ? ` ${Global.stores.plotter.timeShorthand}` : '';
    }

    private _renderProgress(progress: OptimizeProgress) {
        Global.stores.optimizer.set({ progress });

        // When a pass completes (the reported pass advances), rescale the denominator to what's actually
        // been run so far plus an estimate for the passes that MIGHT still run — remaining passes often
        // don't (the search converges), so the up-front candidates × maxPasses over-counts. We keep the
        // bar honest by re-anchoring to evalsSoFar on each boundary.
        if (progress.pass > this._lastPass) {
            this._lastPass = progress.pass;
            const remainingPasses = Math.max(0, this._maxPasses - progress.pass);
            this._estimatedEvals = Math.max(1, progress.evaluations + remainingPasses * this._perPassEvals);
        }

        const done = progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'aborted';
        const label = this._progressLabel(progress, done);
        this._progress.textContent = label;
        this._updateProgressBar(progress.evaluations, done);
    }

    /**
     * Honest one-line progress: what's actually known — the pass (out of an upper bound the search may
     * not reach, hence `≤`), the dimension being searched, sims run, and observed throughput. No ETA
     * derived from the unreliable total; the rough time estimate lives on the bar's ETA line.
     */
    private _progressLabel(progress: OptimizeProgress, done: boolean): string {
        if (done) {
            const best = Number.isFinite(progress.bestMetric) ? this._format(progress.bestMetric) : '—';
            return `${this._phaseLabel(progress.phase)} · ${progress.evaluations} sims · best ${best}`;
        }

        const parts = [`pass ${progress.pass}/≤${this._maxPasses}`];
        // The dimension label is only meaningful while searching a slot; finalize has no active slot.
        if (progress.phase === 'searching') {
            const dimLabel = this._runDims[progress.slotIndex]?.label ?? progress.slotId;
            if (dimLabel) {
                parts.push(dimLabel);
            }
        } else {
            parts.push(this._phaseLabel(progress.phase));
        }
        parts.push(`${progress.evaluations} sims`);

        const elapsed = Date.now() - this._startTime;
        if (progress.evaluations > 0 && elapsed > 0) {
            const perSec = (progress.evaluations / elapsed) * 1000;
            parts.push(`${perSec.toFixed(1)} sims/s`);
        }
        return parts.join(' · ');
    }

    /**
     * How many parallel sim workers to run. Chosen automatically from the CPU — there's no user knob
     * because tuning it well needs details the UI can't surface (true core count, whether the browser
     * under-reports, RAM headroom). Leave one core for the main thread/OS, and cap the count: each
     * worker holds a full copy of the game data (memory), and per-dimension candidate counts rarely
     * exceed this, so extra workers would mostly idle. On ≤2 cores this yields 1 (the serial path).
     */
    private _resolveWorkerCount(): number {
        const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
        return Math.max(1, Math.min(cores - 1, 12));
    }

    /**
     * Build (or reuse) a pool of `size` initialised workers. Reused across runs so the per-worker data
     * load is paid once; rebuilt only when the requested size changes. Returns undefined (falling back
     * to the single-worker path) if the pool fails to start.
     */
    private async _ensurePool(size: number): Promise<WorkerPool | undefined> {
        if (this._pool && this._poolSize === size) {
            return this._pool;
        }
        this._teardownPool();
        try {
            const pool = createWorkerPool(size);
            await pool.init();
            this._pool = pool;
            this._poolSize = size;
            return pool;
        } catch (error) {
            Global.logger.error('Auto-optimize: worker pool failed to start; using a single worker', error);
            this._status.textContent = 'Sim worker pool failed to start — continuing with 1 worker.';
            this._teardownPool();
            return undefined;
        }
    }

    /** Tear down the worker pool and forget it (frees N workers' threads + data). */
    private _teardownPool() {
        if (this._pool) {
            this._pool.terminate();
            this._pool = undefined;
            this._poolSize = 0;
        }
    }

    /**
     * Rough upfront estimate of total evaluations: candidates per (searchable) dimension × max passes,
     * plus the baseline + final re-score. This is only a starting denominator for the bar/ETA and is
     * wrong in both directions — early convergence and cache hits run fewer passes, while the estimate
     * ignores confirm-swap re-scores — so the bar is capped short of 100% until the run reports done,
     * and the per-pass figure is kept so a finished pass can rescale the denominator (see _renderProgress).
     * Records `_perPassEvals`/`_maxPasses` and resets the pass tracker as a side effect.
     */
    private _estimateEvals(): number {
        // With fast search, a slot that has more than screenKeep candidates pays a screen eval for
        // each candidate plus a confirm eval for the screenKeep survivors — so count both, otherwise
        // the progress bar races ahead and then stalls once the confirm passes run.
        const fastSearch = Global.stores.optimizer.state.fastSearch;
        const screenKeep = 3;
        const perPass = this._runDims.reduce((sum, dim) => {
            const candidates = Math.max(0, dim.getCandidates().length - 1);
            const withConfirm = fastSearch && candidates > screenKeep ? candidates + screenKeep : candidates;
            return sum + withConfirm;
        }, 0);
        this._perPassEvals = Math.max(1, perPass);
        this._maxPasses = DEFAULT_OPTIONS.maxPasses;
        this._lastPass = 0;
        return Math.max(1, perPass * this._maxPasses + 2);
    }

    private _updateProgressBar(evaluations: number, done: boolean) {
        // Cap the displayed progress at 95% until the run actually reports done: the denominator is a
        // rough estimate that can be over- or under-shot, and a bar that sits at 100% (or overshoots)
        // while sims are still running reads as stalled. Only `done` (or cancelled/aborted) fills it.
        // Guard against a NaN/Infinity estimate (0-candidate dimensions) so the width stays well-formed.
        const ratio = this._estimatedEvals > 0 ? evaluations / this._estimatedEvals : 0;
        const fraction = done ? 1 : Math.min(0.95, Number.isFinite(ratio) ? Math.max(0, ratio) : 0);
        this._progressBarFill.style.width = `${(fraction * 100).toFixed(1)}%`;

        if (done) {
            this._progressEta.textContent = 'done';
            return;
        }

        const elapsed = Date.now() - this._startTime;
        if (evaluations > 0 && elapsed > 0) {
            const perEval = elapsed / evaluations;
            const remaining = Math.max(0, this._estimatedEvals - evaluations) * perEval;
            // The time is a rough guess off an unreliable total, so label it `~` (see _formatEta).
            this._progressEta.textContent = `~${this._formatEta(remaining)}`;
        } else {
            this._progressEta.textContent = '';
        }
    }

    /** Format a duration as "12s" or "3m 05s". Callers prepend `~` to mark it a rough estimate. */
    private _formatEta(ms: number): string {
        const seconds = Math.max(0, Math.ceil(ms / 1000));
        if (seconds < 60) {
            return `${seconds}s`;
        }
        return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    }

    private _renderResult(result: OptimizeResult) {
        // The run is over regardless of outcome — settle the progress bar at 100%.
        this._updateProgressBar(result.evaluations, true);

        // If even the baseline couldn't be scored, every simulation failed — e.g. the character
        // can't defeat the target (a realm/setup mismatch), or the metric is unavailable for it.
        if (!Number.isFinite(result.baselineMetric)) {
            this._status.textContent = 'Could not optimize.';
            this._results.innerHTML =
                `<div class="mcs-auto-optimize-warn">Every simulation failed for this target. The character ` +
                `couldn't defeat it (often a realm/setup mismatch), or the selected metric isn't available for it. ` +
                `Try a target the character can actually kill, or a different objective/metric.</div>` +
                `<div class="text-muted">${result.evaluations} simulations run.</div>`;
            this._apply.disabled = true;
            return;
        }

        this._status.textContent =
            result.status === 'cancelled' ? 'Cancelled — showing the best found so far.' : 'Done.';

        // Show each metric with its Monte-Carlo standard error (`± se`) so the reader can judge whether
        // baseline→best is a real gain or within noise; omit the `±` where the scorer couldn't estimate it.
        const unit = this._metricUnit();
        const baseline = this._formatWithError(result.baselineMetric, result.baselineStdError, unit);
        const best = this._formatWithError(result.bestMetric, result.bestStdError, unit);

        let html =
            `<div class="mcs-auto-optimize-section-title">Best setup found (local search — not guaranteed optimal)</div>` +
            `<div>baseline ${baseline} &rarr; best ${best}</div>`;

        // A recommendation that survived the low-fidelity search but DIED at full trials is dangerous —
        // it looks safe but isn't. Warn unmissably above Apply (which stays enabled — the user decides).
        if (result.improved && result.bestFeasible === false) {
            html +=
                `<div class="mcs-auto-optimize-warn"><strong>⚠ At full fidelity this setup died ` +
                `(death rate ${(result.bestDeathRate * 100).toFixed(1)}%) despite surviving the search trials. ` +
                `Treat with caution.</strong></div>`;
        }

        if (!result.improved) {
            html += `<div>No improvement found over your current setup.</div>`;
        } else {
            html += `<div><strong>Changes (${result.dimensionDiff.length}):</strong></div><ul>`;
            for (const change of result.dimensionDiff) {
                // For equipment dimensions from/to are item ids; _itemName resolves them to names
                // (and passes through non-id labels from other dimensions unchanged).
                html += `<li>${change.label}: ${this._itemName(change.from)} &rarr; ${this._itemName(change.to)}</li>`;
            }
            html += `</ul>`;
        }

        html += `<div class="text-muted">${result.evaluations} simulations run.</div>`;
        this._results.innerHTML = html;
        this._apply.disabled = !result.improved;
        this._showBestSetup(result);
    }

    /**
     * Once the run is over, repurpose the live "currently evaluating" panel to show the winning setup:
     * the best loadout found (or the unchanged current setup if nothing beat it) plus its final metric.
     */
    private _showBestSetup(result: OptimizeResult) {
        // Cancel any pending throttled repaint so it can't clobber this with the last candidate tried.
        if (this._renderTimer !== undefined) {
            clearTimeout(this._renderTimer);
            this._renderTimer = undefined;
        }
        this._liveTitle.textContent = result.improved ? 'Best setup found' : 'Best setup (unchanged)';
        const loadout =
            result.improved && this._bestEvent
                ? choicesToLoadout(this._runDims, this._bestEvent.choices)
                : this._baselineLoadout;
        if (loadout && this._liveGrid) {
            this._liveGrid.update(loadout);
        }
        const metric = Number.isFinite(result.bestMetric)
            ? `${this._format(result.bestMetric)}${this._metricUnit()}`
            : '—';
        this._liveCaption.textContent = `${metric} · ${(result.bestDeathRate * 100).toFixed(1)}% death`;
    }

    private _itemName(itemId?: string): string {
        if (!itemId) {
            return 'empty';
        }
        return Global.game.items.getObjectByID(itemId)?.name ?? itemId;
    }

    private _phaseLabel(phase: OptimizePhase): string {
        switch (phase) {
            case 'searching':
                return 'Searching';
            case 'finalizing':
                return 'Finalizing';
            case 'done':
                return 'Done';
            case 'cancelled':
                return 'Cancelled';
            case 'aborted':
                return 'Aborted';
            default:
                return 'Working';
        }
    }

    private _format(value: number): string {
        if (!Number.isFinite(value)) {
            return '—';
        }
        return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    /**
     * Format a metric with its standard error and unit for the results panel: `1,234 ± 56 /h`. The
     * `± se` is omitted when the scorer couldn't estimate it (undefined/non-finite stdError); a
     * non-finite metric renders as an em dash with no unit.
     */
    private _formatWithError(value: number, stdError: number | undefined, unit: string): string {
        if (!Number.isFinite(value)) {
            return '—';
        }
        const error = stdError !== undefined && Number.isFinite(stdError) ? ` ± ${this._format(stdError)}` : '';
        return `${this._format(value)}${error}${unit}`;
    }
}

customElements.define('mcs-auto-optimize', AutoOptimizePage);
