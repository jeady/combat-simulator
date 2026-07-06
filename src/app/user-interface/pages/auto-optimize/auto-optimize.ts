import './auto-optimize.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';
import { PageController, PageId } from 'src/app/user-interface/pages/page-controller';
import { Settings, SettingsController } from 'src/app/settings-controller';
import { CoordinateAscentOptimizer, ladderEvalCount } from 'src/app/optimizer/optimizer';
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
    dungeonTargetId,
    getSelectedTarget,
    isSupportedObjective,
    isSupportedTarget,
    slayerTaskTargetId,
    targetImmuneDamageTypeIds
} from 'src/app/optimizer/adapters';
import {
    CancelToken,
    DEFAULT_OPTIONS,
    Dimension,
    DimensionChange,
    DimensionChoice,
    Evaluation,
    OptimizeEvent,
    OptimizeOptions,
    OptimizePhase,
    OptimizeProgress,
    OptimizeResult,
    OptimizeTarget
} from 'src/app/optimizer/types';
import { choicesToLoadout, LiveLoadoutGrid, loadoutRow, RenderedLoadout } from './loadout-view';
import { Dialog } from 'src/app/user-interface/_parts/dialog/dialog';
import { DialogController } from 'src/app/user-interface/_parts/dialog/dialog-controller';
import { TooltipController } from 'src/app/user-interface/_parts/tooltip/tooltip-controller';
import { EquipmentController } from 'src/app/user-interface/pages/_parts/equipment/equipment-controller';
import { ImageLoader } from 'src/app/utils/image-loader';
import { Lookup } from 'src/shared/utils/lookup';

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
 * A dimension restricted to a user-picked allow-list (the "custom" scope): only the selected item
 * ids are searched. "Leave as-is" stays reachable exactly as for any dimension — the incumbent choice
 * is always compared against, so a custom slot can still end up unchanged.
 */
function customizedDimension(dim: Dimension, allowed: ReadonlySet<string>): Dimension {
    return { ...dim, getCandidates: () => dim.getCandidates().filter(c => typeof c === 'string' && allowed.has(c)) };
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

    private readonly _locks: HTMLDivElement;
    private readonly _searchAll: HTMLButtonElement;
    private readonly _lockAll: HTMLButtonElement;
    private readonly _scopeDialog: Dialog;
    private readonly _scopeDialogTitle: HTMLDivElement;
    private readonly _scopeSearch: HTMLInputElement;
    private readonly _scopeItemsHost: HTMLDivElement;
    private readonly _scopeClear: HTMLButtonElement;
    private readonly _scopeSave: HTMLButtonElement;
    private readonly _scopeCancel: HTMLButtonElement;

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

    /**
     * The applier/scorer/target/options of the LAST COMPLETED run, retained so the "Explain changes"
     * button can re-run the leave-one-out loop after `_onRun` has returned (its locals are gone). The
     * applier/scorer operate on the live sim world via snapshots, so they still work later — the
     * scorer holds the reused pool, which stays alive across runs. Invalidated when a new run starts
     * and on disconnectedCallback.
     */
    private _lastRun?: {
        applier: GameLoadoutApplier;
        scorer: MemoizingScorer;
        target: OptimizeTarget;
        runOptions: Partial<OptimizeOptions>;
    };
    /** True once per-change attribution has already been rendered for the current result (auto or manual). */
    private _attributionDone = false;
    /** Explain-changes button, added to the results panel when a run leaves 1..12 unexplained changes. */
    private _explainButton?: HTMLButtonElement;
    /** Cancellation token for an in-flight attribution pass (separate from the search's `_cancel`). */
    private _analysisCancel?: CancelToken;

    /** Reused pool of parallel sim workers (built lazily; rebuilt when the worker count changes). */
    private _pool?: WorkerPool;
    private _poolSize = 0;

    /**
     * Per-dimension search scope. Absent = searched normally; 'locked' = kept exactly as equipped
     * (no candidates); a Set of item ids = "custom": only those hand-picked items are searched.
     */
    private readonly _dimScope = new Map<string, 'locked' | Set<string>>();
    /** Dimensions used for the current/last run, for rendering aligned choice lists. */
    private _runDims: Dimension[] = [];

    private _liveGrid?: LiveLoadoutGrid;
    /** The "Current setup" grid (the user's equipped gear at the start of the run). */
    private _baseGrid?: LiveLoadoutGrid;
    /** Baseline loadout, for the "Current setup" panel and diff-highlighting in the feed/leaderboard. */
    private _baselineLoadout?: RenderedLoadout;
    /** The baseline's RAW per-dimension choices (aligned to _runDims), for risk attribution reverts. */
    private _baselineChoices?: DimensionChoice[];
    private readonly _leaderboardMap = new Map<string, LeaderEntry>();
    private _latest?: OptimizeEvent;
    /** The most recent best-improved event, used to render the winning loadout when the run finishes. */
    private _bestEvent?: OptimizeEvent;
    /** Wall-clock of the last live-view repaint + a pending trailing-repaint timer (see _scheduleRender). */
    private _lastRenderAt = 0;
    private _renderTimer?: number;
    /** PageController page-change subscription, kept so disconnectedCallback can unregister it. */
    private _onPage?: (id: PageId) => void;
    /** The target the active run captured at start; pins the header while the run is in flight. */
    private _runTarget?: OptimizeTarget;
    /** The active run's full search fidelity; leaderboard entries below this are screening noise. */
    private _runSearchTrials = 0;
    /** The active run's screening parameters, so _estimateEvals can mirror the real ladder cost. */
    private _runScreenTrials = 0;
    private _runScreenKeep = 3;
    /**
     * Evaluations completed by FINISHED inner runs (earlier restart seeds, the gear search before the
     * staged progression pass). Each inner optimizer.run restarts its own counter from zero, so every
     * displayed total is offset + the current inner run's count (see _renderProgress's reset detection).
     */
    private _evalsOffset = 0;
    /** The current inner run's latest raw eval counter — the reset-detection anchor. */
    private _lastRunEvals = 0;
    /** Restart seeds still to run after the current one + the per-seed estimate, for bar rescaling. */
    private _seedsRemaining = 0;
    private _perSeedEvals = 1;
    /**
     * Described agility-course/cartography-POI state captured at run start (the world mutates during
     * the search), shown under the Current/Best gear grids. The best panel overlays the progression
     * pass's dimensionDiff on top.
     */
    private _progressionCurrent: { id: string; label: string; text: string }[] = [];
    private _baseProgression?: HTMLDivElement;
    private _bestProgression?: HTMLDivElement;
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

        this._locks = getElementFromFragment(this._content, 'mcs-auto-optimize-locks', 'div');
        this._searchAll = getElementFromFragment(this._content, 'mcs-auto-optimize-search-all', 'button');
        this._lockAll = getElementFromFragment(this._content, 'mcs-auto-optimize-lock-all', 'button');
        this._scopeDialog = getElementFromFragment(this._content, 'mcs-auto-optimize-scope-dialog', 'mcs-dialog');
        this._scopeDialogTitle = getElementFromFragment(this._content, 'mcs-auto-optimize-scope-dialog-title', 'div');
        this._scopeSearch = getElementFromFragment(this._content, 'mcs-auto-optimize-scope-search', 'input');
        this._scopeItemsHost = getElementFromFragment(this._content, 'mcs-auto-optimize-scope-items', 'div');
        this._scopeClear = getElementFromFragment(this._content, 'mcs-auto-optimize-scope-clear', 'button');
        this._scopeSave = getElementFromFragment(this._content, 'mcs-auto-optimize-scope-save', 'button');
        this._scopeCancel = getElementFromFragment(this._content, 'mcs-auto-optimize-scope-cancel', 'button');

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
        // Abort a running "Explain changes" pass and drop the retained run context — its scorer holds
        // the pool we're about to tear down, so it must not be reused after this point.
        if (this._analysisCancel) {
            this._analysisCancel.cancelled = true;
        }
        this._lastRun = undefined;
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
            this._dimScope.clear();
            this._renderLocks();
        };
        this._lockAll.onclick = () => {
            for (const dim of this._buildDisplayDimensions()) {
                this._dimScope.set(dim.id, 'locked');
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

    /**
     * Show the current objective + target. Read live from the Simulate page selections when idle;
     * while a run is active, show the target the RUN captured — the live plotter selection can be
     * deselected mid-run (clicking around the Simulate page), and re-rendering "None selected" while
     * the search is visibly fighting that very target reads as a bug.
     */
    private _refreshObjective() {
        const plot = Global.stores.plotter.plotType;
        const target = this._runTarget ?? getSelectedTarget();
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
                    ? `<div class="mcs-auto-optimize-warn">${this._unsupportedTargetMessage(target)}</div>`
                    : ''
            }
        `;
    }

    /** Why the selected target can't be optimized — matches the isSupportedTarget rejection. */
    private _unsupportedTargetMessage(target: OptimizeTarget | undefined): string {
        if (slayerTaskTargetId(target)) {
            return "You can't reach any monster in this slayer task with your current setup, so there's nothing to optimize. Pick a different task or target on the Simulate page.";
        }
        return "This target has no monsters the simulator can fight, so there's nothing to optimize. Pick a different target on the Simulate page.";
    }

    /** Human-readable name for the selected target — a monster, a dungeon/area, or a slayer-task tier. */
    private _targetName(target: OptimizeTarget | undefined): string {
        if (!target) {
            return 'None selected';
        }
        const taskId = slayerTaskTargetId(target);
        if (taskId) {
            return `${Lookup.tasks.getObjectByID(taskId)?.name ?? taskId} (slayer task)`;
        }
        const dungeonId = dungeonTargetId(target);
        if (dungeonId) {
            const kind = Lookup.isDungeon(dungeonId) ? 'dungeon' : Lookup.isStronghold(dungeonId) ? 'stronghold' : 'abyss depth';
            return `${(Lookup.getEntity(dungeonId) as { name?: string } | undefined)?.name ?? dungeonId} (${kind})`;
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

    /**
     * Render the search-scope panel: the equipment slots as a paper-doll grid (the same layout as the
     * gear panels) plus a strip for the non-equipment dimensions, each cell named and showing its
     * current choice. Clicking a cell cycles its scope: searched → locked → custom (pick the exact
     * items to try) → searched. Custom is equipment-only; other dimensions toggle searched/locked.
     */
    private _renderLocks() {
        const dims = this._buildDisplayDimensions();
        this._locks.innerHTML = '';

        const slotDims = new Map<string, Dimension>();
        const otherDims: Dimension[] = [];
        for (const dim of dims) {
            if (Global.game.equipmentSlots.getObjectByID(dim.id)) {
                slotDims.set(dim.id, dim);
            } else {
                otherDims.push(dim);
            }
        }

        const grid = createElement('div', { classList: ['mcs-ao-grid'] });
        const size = (EquipmentSlot as any).getGridSize();
        grid.style.gridTemplateColumns = `repeat(${size.cols.max - size.cols.min + 1}, auto)`;
        grid.style.gridTemplateRows = `repeat(${size.rows.max - size.rows.min + 1}, auto)`;

        Global.game.equipmentSlots.forEach(slot => {
            const dim = slotDims.get(slot.id);
            if (!dim) {
                return; // slot not searched by the optimizer (no dimension) — no scope to set
            }
            const itemId = dim.getCurrentChoice() as string | null;
            const item = itemId ? Global.game.items.equipment.getObjectByID(itemId) : undefined;
            const img = createElement('img', { classList: ['mcs-ao-icon-img'] });
            ImageLoader.register(img, item ? item.media : slot.emptyMedia);

            const cell = this._scopeCell(dim, slot.localID, img, true);
            cell.classList.add('mcs-ao-icon');
            cell.classList.toggle('mcs-ao-icon-empty', !item);
            cell.style.gridColumn = `${slot.gridPosition.col + (1 - size.cols.min)}`;
            cell.style.gridRow = `${slot.gridPosition.row + (1 - size.rows.min)}`;
            grid.appendChild(cell);
        });

        // Non-equipment dimensions (food/potion/prayers/spells/style/summon pairs): icon + name, so
        // there's no ambiguity about which lever a cell controls.
        const strip = createElement('div', { classList: ['mcs-ao-scope-strip'] });
        for (const dim of otherDims) {
            const content = createElement('div', { classList: ['mcs-ao-scope-item-content'] });
            content.appendChild(loadoutRow(choicesToLoadout([dim], [dim.getCurrentChoice()])));
            content.appendChild(createElement('div', { classList: ['mcs-ao-scope-label'], text: dim.label }));
            const cell = this._scopeCell(dim, dim.label, content, false);
            cell.classList.add('mcs-ao-scope-item');
            strip.appendChild(cell);
        }

        this._locks.append(grid, strip);
    }

    /** One scope cell: content + state badge + tooltip + the click handler that cycles the scope. */
    private _scopeCell(dim: Dimension, name: string, content: HTMLElement, allowCustom: boolean): HTMLDivElement {
        const scope = this._dimScope.get(dim.id);
        const mode = scope === 'locked' ? 'locked' : scope instanceof Set ? 'custom' : 'searched';

        const cell = createElement('div', { classList: ['mcs-ao-scope-cell'] });
        cell.classList.toggle('mcs-ao-scope-locked', mode === 'locked');
        cell.classList.toggle('mcs-ao-scope-custom', mode === 'custom');
        cell.setAttribute('data-mcsTooltip', '');
        cell.appendChild(content);

        if (mode !== 'searched') {
            const badge = mode === 'locked' ? '🔒' : `${(scope as Set<string>).size}`;
            cell.appendChild(createElement('div', { classList: ['mcs-ao-scope-badge'], text: badge }));
        }

        const state =
            mode === 'locked'
                ? 'LOCKED — kept as it currently is'
                : mode === 'custom'
                  ? `CUSTOM — only the ${(scope as Set<string>).size} hand-picked item(s) are searched`
                  : 'searched';
        const next = allowCustom
            ? 'click to cycle searched → locked → custom'
            : 'click to toggle searched / locked';
        const tooltip = createElement('div', { attributes: [['data-mcsTooltipContent', '']] });
        tooltip.innerHTML = `<strong>${name}</strong><br>${state}<br><em>${next}</em>`;
        cell.appendChild(tooltip);
        TooltipController.init(cell);

        cell.onclick = () => {
            if (mode === 'searched') {
                this._dimScope.set(dim.id, 'locked');
                this._renderLocks();
            } else if (mode === 'locked' && allowCustom) {
                this._openScopePicker(dim, name);
            } else if (mode === 'custom') {
                this._openScopePicker(dim, name); // re-edit the selection ("Search all" clears it)
            } else {
                this._dimScope.delete(dim.id);
                this._renderLocks();
            }
        };
        return cell;
    }

    /**
     * The custom-scope item picker (the equipment-select-style dialog): shows the dimension's actual
     * candidate list (already pool/attack-type/target filtered), click to multi-select. Save with a
     * selection => custom scope; Save empty or "Search all" => back to searched; Cancel keeps the
     * previous scope — except when cycling in from LOCKED, where Cancel completes the cycle back to
     * searched (so plain clicking always cycles through all three states).
     */
    private _openScopePicker(dim: Dimension, name: string) {
        const existing = this._dimScope.get(dim.id);
        const selected = new Set<string>(existing instanceof Set ? existing : []);
        const candidates = dim.getCandidates().filter((c): c is string => typeof c === 'string');

        this._scopeDialogTitle.textContent = `${name} — pick the items to search`;
        this._scopeSearch.value = '';
        this._scopeItemsHost.innerHTML = '';

        const cells = new Map<string, { element: HTMLDivElement; item: EquipmentItem }>();
        for (const itemId of candidates) {
            const item = Global.game.items.equipment.getObjectByID(itemId);
            if (!item) {
                continue;
            }
            const element = createElement('div', {
                classList: ['mcs-equipment-slot-item'],
                attributes: [['data-mcsTooltip', '']]
            });
            element.classList.toggle('mcs-ao-scope-selected', selected.has(itemId));
            const img = createElement('img');
            img.style.clipPath = 'inset(2.6px)';
            ImageLoader.register(img, item.media);
            element.appendChild(img);
            const tooltip = createElement('div', { attributes: [['data-mcsTooltipContent', '']] });
            tooltip.innerHTML = EquipmentController.getEquipmentTooltip(item);
            element.appendChild(tooltip);
            TooltipController.init(element);
            element.onclick = () => {
                if (selected.has(itemId)) {
                    selected.delete(itemId);
                } else {
                    selected.add(itemId);
                }
                element.classList.toggle('mcs-ao-scope-selected', selected.has(itemId));
            };
            cells.set(itemId, { element, item });
            this._scopeItemsHost.appendChild(element);
        }

        this._scopeSearch.oninput = () => {
            const value = this._scopeSearch.value.toLowerCase();
            for (const { element, item } of cells.values()) {
                element.style.display = !value || EquipmentController.isMatch(item, value) ? '' : 'none';
            }
        };

        let outcome: 'save' | 'clear' | undefined;
        this._scopeSave.onclick = () => {
            outcome = 'save';
            DialogController.close();
        };
        this._scopeClear.onclick = () => {
            outcome = 'clear';
            DialogController.close();
        };
        this._scopeCancel.onclick = () => DialogController.close();

        TooltipController.hide();
        DialogController.open(this._scopeDialog, () => {
            this._scopeItemsHost.innerHTML = '';
            if (outcome === 'save' && selected.size > 0) {
                this._dimScope.set(dim.id, selected);
            } else if (outcome !== undefined || !(existing instanceof Set)) {
                // "Search all", Save-with-nothing, or Cancel while cycling in from LOCKED.
                this._dimScope.delete(dim.id);
            }
            this._renderLocks();
        });
    }

    /** Apply the user's scope to a dimension for the run: locked, custom allow-list, or as-is. */
    private _scopedDimension(dim: Dimension): Dimension {
        const scope = this._dimScope.get(dim.id);
        if (scope === 'locked') {
            return lockedDimension(dim);
        }
        if (scope instanceof Set && scope.size > 0) {
            return customizedDimension(dim, scope);
        }
        return dim;
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
            this._status.textContent = this._unsupportedTargetMessage(target);
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
        this._runTarget = target;
        this._runSearchTrials = searchTrials;
        // Fast search: screen every candidate at a quarter of the search trials, then race the
        // survivors up the rung ladder. Captured as fields so runOptions and _estimateEvals use the
        // SAME values — the estimate mirrors the ladder's exact eval accounting (ladderEvalCount).
        this._runScreenTrials = fastSearch ? Math.max(10, Math.floor(searchTrials / 4)) : 0;
        this._runScreenKeep = 3;
        this._refreshObjective();
        this._result = undefined;
        // A new run invalidates the previous run's retained context + any rendered attribution.
        this._lastRun = undefined;
        this._attributionDone = false;
        this._explainButton = undefined;
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
        // Resolve 'current' to the player's CONCRETE attack type once, at run start. The provider
        // otherwise re-resolves 'current' against the LIVE player on every getCandidates call — and
        // with multi-start restarts, seed randomization can leave a seed unarmed (a random shield
        // unequips a random 2H), flipping the live attack type to melee and letting that seed's whole
        // search hunt weapons of the wrong type.
        const storedConstraint = Global.stores.optimizer.state.attackTypeConstraint;
        const attackTypeConstraint: AttackTypeConstraint =
            storedConstraint === 'current'
                ? (Global.game.combat.player.attackType as AttackTypeConstraint) ?? 'current'
                : storedConstraint;
        const itemPool = Global.stores.optimizer.state.itemPool;
        // Consumables (food/potion/summons) follow the same pool at the coarse owned-vs-all level:
        // 'owned' and 'craftable' keep them owned-only (craftability is a gear concept), 'all' opens
        // them up. Equipment gets the full tri-state via the candidate provider. Weapons whose damage
        // type can't hurt this run's target are dropped up front (they'd burn a full tick budget per
        // sim just to fail — e.g. Normal-damage weapons against an abyssal monster).
        const targetImmunities = targetImmuneDamageTypeIds(target);
        this._runDims = buildDimensions(
            applier,
            new GameCandidateProvider(itemPool, attackTypeConstraint, targetImmunities),
            {
                preRankTopK,
                ownedOnly: itemPool !== 'all'
            }
        ).map(dim => this._scopedDimension(dim));
        // Progression context for the gear panels: the agility course + cartography POI in use (for
        // the target's realm). Snapshot the DESCRIBED values now — the world mutates during the
        // search. The best panel overlays the progression pass's changes when the run completes.
        const targetMonster = Global.game.monsters.getObjectByID(target.monsterId);
        const targetRealmId = targetMonster ? Global.game.getMonsterArea(targetMonster).realm?.id : undefined;
        const progressionDims = [...(targetRealmId ? agilityDimensions(targetRealmId) : []), ...cartographyDimensions()];
        this._progressionCurrent = progressionDims.map(dim => ({
            id: dim.id,
            label: dim.label,
            text: dim.describe(dim.getCurrentChoice())
        }));
        if (this._baseProgression) {
            this._baseProgression.innerHTML = this._progressionLines().join('<br>');
        }
        // Estimate total work up front (candidates × passes) to drive the progress bar + ETA. With
        // restarts, the same search runs once per seed, so the denominator scales by the seed count.
        this._perSeedEvals = this._estimateEvals();
        this._seedsRemaining = restarts - 1;
        this._estimatedEvals = this._perSeedEvals * restarts;
        this._evalsOffset = 0;
        this._lastRunEvals = 0;
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
            // Fast search screening (see the field capture at run start). The optimizer skips the
            // screen pass automatically for slots that have ≤ screenKeep candidates (no benefit there).
            screenTrials: this._runScreenTrials,
            screenKeep: this._runScreenKeep,
            // Slayer-task/dungeon aggregates run unbatched, so they can't estimate stdError and the
            // z·SE significance gate is inert — swaps would commit on any noise-level delta. Require a
            // 1% relative gain there instead (single-monster targets keep the statistical gate).
            minRelImprovement: slayerTaskTargetId(target) || dungeonTargetId(target) ? 0.01 : 0
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
            // Retain this run's context so the "Explain changes" button can re-run the leave-one-out
            // loop later (its applier/scorer operate on the live sim world, and the scorer holds the
            // reused pool). Set before _renderResult so it can wire the button.
            this._lastRun = { applier, scorer, target, runOptions };
            this._renderResult(result);
            // When the winner still shows deaths at full fidelity, attribute the risk automatically:
            // re-sim the best setup with each gear change individually reverted, so the user can see
            // WHICH slot carries the danger instead of guessing across the whole diff. The same
            // leave-one-out data also answers "which changes mattered?", so this run doubles as the
            // per-change breakdown — the "Explain changes" button covers the no-death case.
            if (result.improved && result.bestDeathRate > 0 && !cancel.cancelled) {
                await this._runAttribution('death', result, applier, scorer, target, runOptions, cancel);
            }
        } catch (error) {
            this._status.textContent = `Optimization failed: ${(error as Error)?.message ?? String(error)}`;
            Global.logger.error('Auto-optimize failed', error);
        } finally {
            Global.stores.optimizer.set({ isRunning: false });
            this._cancel = undefined;
            this._runTarget = undefined;
            this._refreshObjective();
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
        // One run timeline: keep the start time, and add the gear search's sims to the denominator —
        // the pass's own counter restarts at zero and is folded back in by _renderProgress's reset
        // detection, so the label/bar keep counting whole-run totals through the staged pass.
        this._estimatedEvals = this._evalsOffset + this._lastRunEvals + this._estimateEvals();

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
        // Seeds still to run after this one — keeps the bar's pass-boundary rescale from dropping the
        // not-yet-started seeds out of the denominator (seedIndex is 1-based, "about to run").
        this._seedsRemaining = Math.max(0, progress.seedCount - progress.seedIndex);
    }

    private _onApply() {
        if (!this._result || !this._result.improved) {
            return;
        }

        // bestSetup is the full winning configuration (a Settings snapshot); apply it directly. The
        // button stays enabled so the user can fiddle with the loadout and re-apply to get back to
        // the optimizer's recommendation at any time (until the next run replaces the result).
        SettingsController.import(this._result.bestSetup as Settings);

        this._status.textContent = 'Applied the best setup to your configuration — click again anytime to re-apply.';
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
        this._baselineChoices = undefined;
        this._feed.innerHTML = '';
        this._leaderboard.innerHTML = '';
        this._liveTitle.textContent = 'Currently evaluating';
        this._liveCaption.textContent = '';
        this._liveGridHost.innerHTML = '';
        this._liveGrid = new LiveLoadoutGrid();
        this._liveGridHost.appendChild(this._liveGrid.element);
        // Agility/cartography strip — empty while candidates stream (the search never varies them
        // live); filled with the winner's progression state when the run completes.
        this._bestProgression = createElement('div', { classList: ['mcs-ao-progression', 'text-muted'] });
        this._liveGridHost.appendChild(this._bestProgression);

        this._baseCaption.textContent = '';
        this._baseGridHost.innerHTML = '';
        this._baseGrid = new LiveLoadoutGrid();
        this._baseGridHost.appendChild(this._baseGrid.element);
        this._baseProgression = createElement('div', { classList: ['mcs-ao-progression', 'text-muted'] });
        this._baseGridHost.appendChild(this._baseProgression);

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
            this._baselineChoices = event.choices;
            this._baselineLoadout = choicesToLoadout(this._runDims, event.choices);
            this._baseGrid?.update(this._baselineLoadout);
            this._baseCaption.textContent = this._scoreCaption('Current', event);
        }

        // Only full-fidelity evaluations may rank on the leaderboard: screening-rung evals run at a
        // fraction of the trials, and picking the max of many noisy samples selects for lucky rolls —
        // a low-trial outlier would sit at #1 above the search's actual (confirmed) best.
        const fullFidelity = event.trials === undefined || event.trials >= this._runSearchTrials;
        const key = JSON.stringify(event.choices);
        const existing = this._leaderboardMap.get(key);
        if (fullFidelity && (!existing || this._directed(event.metric) > this._directed(existing.metric))) {
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
            // With restarts, every seed emits its own best-improved chain; keep the best ACROSS seeds
            // (feasible first, then directed metric — the leaderboard's order) so the completed-run
            // panel shows the run's true winner, not just the last seed to improve.
            const prev = this._bestEvent;
            const isBetter =
                !prev ||
                (event.feasible !== prev.feasible
                    ? event.feasible
                    : this._directed(event.metric) > this._directed(prev.metric));
            if (isBetter) {
                this._bestEvent = event;
            }
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
            // Events carry the current inner run's counter; offset it like _renderProgress does.
            this._updateProgressBar(this._evalsOffset + this._latest.evaluations, false);
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

        // Each inner run (a restart seed, the staged progression pass) restarts its eval counter from
        // zero. Detect the reset and fold the finished run's count into the offset, so the sims label,
        // throughput and bar all report whole-run totals instead of the current sub-run's counter.
        if (progress.evaluations < this._lastRunEvals) {
            this._evalsOffset += this._lastRunEvals;
            this._lastPass = 0; // the new inner run re-reports pass 1; re-anchor its boundary rescale
        }
        this._lastRunEvals = progress.evaluations;
        const totalEvals = this._evalsOffset + progress.evaluations;

        // When a pass completes (the reported pass advances), rescale the denominator to what's actually
        // been run so far plus an estimate for the work that MIGHT still run — remaining passes often
        // don't (the search converges), so the up-front candidates × maxPasses over-counts. Remaining
        // restart seeds keep their up-front per-seed estimate. We keep the bar honest by re-anchoring
        // to the sims actually done on each boundary.
        if (progress.pass > this._lastPass) {
            this._lastPass = progress.pass;
            // The boundary fires on the FIRST event of the new pass, so that pass still has to run —
            // include it in the remaining budget (maxPasses - pass + 1). Budgeting only the passes
            // after it left the final pass with a zero-remaining denominator (ETA pinned at ~0s).
            const remainingPasses = Math.max(0, this._maxPasses - progress.pass + 1);
            this._estimatedEvals = Math.max(
                1,
                totalEvals + remainingPasses * this._perPassEvals + this._seedsRemaining * this._perSeedEvals
            );
        }

        const done = progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'aborted';
        const label = this._progressLabel(progress, done, totalEvals);
        this._progress.textContent = label;
        this._updateProgressBar(totalEvals, done);
    }

    /**
     * Honest one-line progress: what's actually known — the pass (out of an upper bound the search may
     * not reach, hence `≤`), the dimension being searched, sims run, and observed throughput. No ETA
     * derived from the unreliable total; the rough time estimate lives on the bar's ETA line.
     */
    private _progressLabel(progress: OptimizeProgress, done: boolean, totalEvals: number): string {
        if (done) {
            const best = Number.isFinite(progress.bestMetric) ? this._format(progress.bestMetric) : '—';
            return `${this._phaseLabel(progress.phase)} · ${totalEvals} sims · best ${best}`;
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
        parts.push(`${totalEvals} sims`);

        const elapsed = Date.now() - this._startTime;
        if (totalEvals > 0 && elapsed > 0) {
            const perSec = (totalEvals / elapsed) * 1000;
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
     * Rough upfront estimate of total evaluations: per-dimension ladder cost (ladderEvalCount — the
     * exact screening-rung + confirm accounting the optimizer runs) × max passes, plus the baseline +
     * final re-score. Still only a starting denominator for the bar/ETA — early convergence and cache
     * hits run fewer passes, and confirm-swap replicates aren't counted — so the bar is capped short
     * of 100% until the run reports done, and the per-pass figure is kept so a finished pass can
     * rescale the denominator (see _renderProgress). Records `_perPassEvals`/`_maxPasses` and resets
     * the pass tracker as a side effect.
     */
    private _estimateEvals(): number {
        const perPass = this._runDims.reduce((sum, dim) => {
            const candidates = Math.max(0, dim.getCandidates().length - 1);
            return sum + ladderEvalCount(candidates, this._runScreenTrials, this._runSearchTrials, this._runScreenKeep);
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
        if (evaluations > 0 && elapsed > 0 && evaluations < this._estimatedEvals) {
            const perEval = elapsed / evaluations;
            const remaining = (this._estimatedEvals - evaluations) * perEval;
            // The time is a rough guess off an unreliable total, so label it `~` (see _formatEta).
            this._progressEta.textContent = `~${this._formatEta(remaining)}`;
        } else {
            // Nothing measured yet, or the estimate is exhausted while the run continues — show no
            // time rather than a confidently wrong "~0s".
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

        // Survivability context for the recommendation: the worst single hit each setup took. Shows
        // why a metric-tied pick broke the way it did (ties prefer the lower worst-hit).
        if (result.baselineHighestDamageTaken !== undefined && result.bestHighestDamageTaken !== undefined) {
            html +=
                `<div class="text-muted">Worst hit taken: ${this._format(result.baselineHighestDamageTaken)}` +
                ` &rarr; ${this._format(result.bestHighestDamageTaken)}</div>`;
        }

        // Deterministic spike-safety check: a single hit at or above the auto-eat threshold can kill
        // from just-eaten HP no matter how lucky the sampled trials were — the sampled death rate
        // UNDERSTATES the risk whenever this triggers. Read the threshold with the winner applied
        // (auto-eat scales with the setup's max HP), then restore.
        if (result.improved && result.bestHighestDamageTaken !== undefined) {
            const saved = SettingsController.export();
            SettingsController.import(result.bestSetup as Settings);
            const autoEat = Math.floor(Global.game.combat.player.autoEatThreshold);
            SettingsController.import(saved);
            if (autoEat > 0 && result.bestHighestDamageTaken >= autoEat) {
                html +=
                    `<div class="mcs-auto-optimize-warn">⚠ Spike risk: the worst hit taken ` +
                    `(${this._format(result.bestHighestDamageTaken)}) meets or exceeds this setup's auto-eat ` +
                    `threshold (${this._format(autoEat)}). Back-to-back spikes can kill even when the sampled ` +
                    `death rate looks low — treat the death rate above as a lower bound.</div>`;
            }
        }

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
        this._maybeAddExplainButton(result);
        this._showBestSetup(result);
    }

    /**
     * Offer the "Explain changes" button when a run improved with a tractable number of REVERTIBLE
     * changes (1..12, the cap the leave-one-out loop can afford) AND per-change attribution hasn't
     * already run. The automatic death-risk pass renders the same per-change data, so when it will fire
     * (bestDeathRate > 0) we skip the button — that section already answers "which changes mattered".
     * The count is `_attributableChanges` (gear/consumable dims only), NOT dimensionDiff.length, so a
     * result whose only changes are progression-pass ones (which can't be reverted here) shows no button.
     */
    private _maybeAddExplainButton(result: OptimizeResult) {
        this._explainButton = undefined;
        const changeCount = this._attributableChanges().length;
        if (!result.improved || this._attributionDone || result.bestDeathRate > 0 || changeCount < 1 || changeCount > 12) {
            return;
        }
        const button = createElement('button', {
            classList: ['mcs-button-secondary', 'mcs-auto-optimize-explain'],
            text: 'Explain changes',
            attributes: [['type', 'button']]
        });
        button.title = 'Re-sim the best setup with each change reverted one at a time to measure what each change contributes.';
        button.onclick = () => this._onExplain();
        this._results.appendChild(button);
        this._explainButton = button;
    }

    /**
     * "Explain changes" handler: re-run the leave-one-out loop on the last completed run, sorted by
     * metric contribution (biggest first). Disables Run + the button while it works and toggles the
     * button to a cancellable "Cancel" state. Restores the user's setup afterward (the attribution
     * loop's own finally handles that). No-ops if the retained context is gone (a new run cleared it).
     */
    private async _onExplain() {
        const run = this._lastRun;
        const result = this._result;
        if (!run || !result || this._analysisCancel) {
            return;
        }
        const cancel: CancelToken = { cancelled: false };
        this._analysisCancel = cancel;
        this._run.disabled = true;
        // Apply mutates the same sim world the attribution loop is snapshotting between evaluations, so
        // freeze it while the pass is in flight; re-enable it after (the result is still applicable).
        const applyWasEnabled = !this._apply.disabled;
        this._apply.disabled = true;
        const button = this._explainButton;
        if (button) {
            button.textContent = 'Cancel';
            button.onclick = () => {
                cancel.cancelled = true;
                button.disabled = true;
            };
        }
        try {
            await this._runAttribution('explain', result, run.applier, run.scorer, run.target, run.runOptions, cancel);
        } finally {
            this._analysisCancel = undefined;
            this._run.disabled = false;
            this._apply.disabled = !applyWasEnabled;
            // If the pass was cancelled before it rendered anything (no rows), _renderAttribution never
            // ran, so the button is still ours — reset it from "Cancel" back to a clickable "Explain
            // changes" so the user can retry. If it did render, _renderAttribution removed the button.
            if (this._explainButton === button && button && !this._attributionDone) {
                button.textContent = 'Explain changes';
                button.disabled = false;
                button.onclick = () => this._onExplain();
            }
        }
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
            // Highlight every slot that differs from the user's current setup, like the new-best feed
            // rows do (diffing baseline against itself in the unchanged case highlights nothing).
            this._liveGrid.update(loadout, undefined, this._baselineLoadout);
        }
        const metric = Number.isFinite(result.bestMetric)
            ? `${this._format(result.bestMetric)}${this._metricUnit()}`
            : '—';
        this._liveCaption.textContent = `${metric} · ${(result.bestDeathRate * 100).toFixed(1)}% death`;
        if (this._bestProgression) {
            const lines = this._progressionLines(result.improved ? result.dimensionDiff : undefined);
            this._bestProgression.innerHTML = lines.join('<br>');
        }
    }

    /**
     * One line per progression lever for the gear panels: the agility course (obstacles joined) and
     * the cartography POI. `diff` (a completed run's dimensionDiff) overrides entries the staged
     * progression pass changed — its from/to are already described names.
     */
    private _progressionLines(diff?: DimensionChange[]): string[] {
        if (this._progressionCurrent.length === 0) {
            return [];
        }
        const value = (entry: { id: string; text: string }) =>
            diff?.find(change => change.dimensionId === entry.id)?.to ?? entry.text;
        const agility = this._progressionCurrent.filter(entry => entry.id.startsWith('agility-'));
        const rest = this._progressionCurrent.filter(entry => !entry.id.startsWith('agility-'));
        const lines: string[] = [];
        if (agility.length > 0) {
            lines.push(`<strong>Agility:</strong> ${agility.map(value).join(' · ')}`);
        }
        for (const entry of rest) {
            lines.push(`<strong>${entry.label}:</strong> ${value(entry)}`);
        }
        return lines;
    }

    /**
     * The `_runDims` indices whose best choice differs from the baseline — the changes the leave-one-out
     * loop can actually revert. This is NOT `dimensionDiff.length`: the staged progression pass appends
     * agility/cartography changes to `dimensionDiff` that aren't dimensions of this run, so they can't be
     * reverted here. Returns [] when the best/baseline choices aren't available (e.g. the run failed).
     */
    private _attributableChanges(): number[] {
        const bestChoices = this._bestEvent?.choices;
        const baseChoices = this._baselineChoices;
        if (!bestChoices || !baseChoices) {
            return [];
        }
        const changed: number[] = [];
        for (let i = 0; i < this._runDims.length; i++) {
            if (!this._runDims[i].equals(bestChoices[i], baseChoices[i])) {
                changed.push(i);
            }
        }
        return changed;
    }

    /**
     * Leave-one-out attribution: re-sim the best setup with each changed dimension reverted to the
     * user's original choice — full trials, cache-bypassing, and NO death-abort (measure, don't race).
     * The metric delta per reverted change IS that change's marginal contribution to the result, and
     * the death-rate delta shows which change carries any residual risk. One loop, two framings:
     *  - `'death'` (auto): fires when the winner still dies; sorted risky-first (lowest remaining death
     *    rate leads), titled around the death risk. This is today's behavior, unchanged.
     *  - `'explain'` (button): the manual "which changes mattered?" pass; sorted by metric contribution
     *    descending (biggest contributor first).
     * Both render through the one shared renderer. Progression-pass changes (agility/cartography)
     * aren't dimensions of this run and are skipped. Streams a "i/N" status while it works.
     */
    private async _runAttribution(
        mode: 'death' | 'explain',
        result: OptimizeResult,
        applier: GameLoadoutApplier,
        scorer: MemoizingScorer,
        target: OptimizeTarget,
        runOptions: Partial<OptimizeOptions>,
        cancel: CancelToken
    ) {
        const changed = this._attributableChanges();
        const baseChoices = this._baselineChoices;
        // Nothing to attribute, or too many changes to afford a full-fidelity eval for each. (The
        // button gate already checks this, but the auto path calls in without one.)
        if (!baseChoices || changed.length === 0 || changed.length > 12) {
            return;
        }

        const trials = runOptions.finalTrials ?? DEFAULT_OPTIONS.finalTrials;
        const ticks = runOptions.finalTicks ?? DEFAULT_OPTIONS.finalTicks;
        const statusPrefix =
            mode === 'death' ? 'Analyzing which changes carry the death risk' : 'Analyzing which changes mattered';

        const rows: { label: string; without: Evaluation }[] = [];
        try {
            for (const i of changed) {
                if (cancel.cancelled) {
                    break;
                }
                this._status.textContent = `${statusPrefix}… ${rows.length + 1}/${changed.length}`;
                applier.restore(result.bestSetup);
                this._runDims[i].applyChoice(baseChoices[i]);
                const without = await scorer.evaluateFresh(target, trials, ticks);
                rows.push({ label: this._runDims[i].label, without });
            }
        } finally {
            // Always leave the user's setup as the run's finally left it (the run itself already
            // restored it; this restores after our own reverts, on completion, cancel, or a throw).
            applier.restore(result.baselineSetup);
        }
        if (rows.length === 0) {
            this._status.textContent = cancel.cancelled ? 'Cancelled.' : 'Done.';
            return;
        }

        this._renderAttribution(mode, result, rows, trials);
        this._status.textContent = cancel.cancelled ? 'Cancelled — showing partial results.' : 'Done.';
    }

    /**
     * Shared renderer for both attribution paths (§7.3). Each row is the best setup with one change
     * reverted; we report per change: the metric contribution (what reverting costs, as an absolute
     * value with unit and as a % of best), the death-rate delta, and the worst-hit delta where the
     * scorer measured it. `mode` only picks the sort + framing; the row HTML is identical. Rendered by
     * replacing any prior attribution section (an in-place re-render never stacks two lists) — the
     * Explain button, if present, is consumed here so the button and its results don't coexist.
     */
    private _renderAttribution(
        mode: 'death' | 'explain',
        result: OptimizeResult,
        rows: { label: string; without: Evaluation }[],
        trials: number
    ) {
        const unit = this._metricUnit();
        // Metric contribution of reverting a change = best − without (directed so "how much you'd lose"
        // is positive for a genuine contributor, regardless of maximize/minimize).
        const contribution = (row: { without: Evaluation }) =>
            Number.isFinite(row.without.metric) ? this._directed(result.bestMetric) - this._directed(row.without.metric) : -Infinity;

        if (mode === 'death') {
            // Risky-first: the reversal that leaves the LOWEST remaining death rate leads the list.
            rows.sort((a, b) => (a.without.deathRate ?? 1) - (b.without.deathRate ?? 1));
        } else {
            // Biggest contributor first: the change that costs the most metric to revert leads.
            rows.sort((a, b) => contribution(b) - contribution(a));
        }

        const title = mode === 'death' ? 'Death-risk attribution' : 'What each change contributed';
        const desc =
            mode === 'death'
                ? `The best setup re-simmed with each change individually reverted (${trials} trials each). ` +
                  `A big death-rate drop means that slot carries the risk; the metric figure is what reverting it costs.`
                : `The best setup re-simmed with each change individually reverted (${trials} trials each). ` +
                  `The metric figure is that change's marginal contribution — what you'd lose by not making it.`;

        let html = `<div class="mcs-auto-optimize-section-title">${title}</div>`;
        html += `<div class="text-muted">${desc}</div><ul>`;
        for (const row of rows) {
            const delta = contribution(row);
            const metricText =
                Number.isFinite(delta) && Number.isFinite(result.bestMetric) && result.bestMetric !== 0
                    ? `${this._format(Math.abs(delta))}${unit} (${((Math.abs(delta) / Math.abs(result.bestMetric)) * 100).toFixed(1)}%)`
                    : '—';
            const death = `${(result.bestDeathRate * 100).toFixed(2)}% &rarr; ${(row.without.deathRate * 100).toFixed(2)}%`;
            const worstHit =
                row.without.highestDamageTaken !== undefined && result.bestHighestDamageTaken !== undefined
                    ? ` · worst hit ${this._format(result.bestHighestDamageTaken)} &rarr; ${this._format(row.without.highestDamageTaken)}`
                    : '';
            html += `<li><strong>${row.label}</strong> reverted: metric ${metricText} · death ${death}${worstHit}</li>`;
        }
        html += `</ul>`;

        // Replace any prior attribution section (so re-running the button doesn't stack lists) and drop
        // the Explain button — its work is now shown inline.
        this._attributionDone = true;
        if (this._explainButton) {
            this._explainButton.remove();
            this._explainButton = undefined;
        }
        this._results.querySelector('.mcs-auto-optimize-attribution')?.remove();
        const section = createElement('div', { classList: ['mcs-auto-optimize-attribution'] });
        section.innerHTML = html;
        this._results.appendChild(section);
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
