import './auto-optimize.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';
import { PageController, PageId } from 'src/app/user-interface/pages/page-controller';
import { Settings, SettingsController } from 'src/app/settings-controller';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { MemoizingScorer, stableStringify } from 'src/app/optimizer/cache';
import { BatchingScorer } from 'src/app/optimizer/batching';
import {
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
}

/**
 * Wrap a dimension so the optimizer never varies it — its single choice is "stay as-is", so the
 * inner search skips it. It still appears in the aligned choice list (so the live grid renders the
 * locked slot's real item), it just never changes. This is how the "lock a slot" control works.
 */
function lockedDimension(dim: Dimension): Dimension {
    return { ...dim, getCandidates: () => [] };
}

@LoadTemplate('app/user-interface/pages/auto-optimize/auto-optimize.html')
export class AutoOptimizePage extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _objective: HTMLDivElement;
    private readonly _searchTrials: HTMLInputElement;
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

    private readonly _scorer = new GameScorer();
    private _cancel?: CancelToken;
    private _result?: OptimizeResult;

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
    private _renderScheduled = false;
    private _leaderboardSig = '';
    /** Progress-bar/ETA bookkeeping: rough total-evaluation estimate + run start time. */
    private _estimatedEvals = 1;
    private _startTime = 0;

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-auto-optimize-page-template'));

        this._objective = getElementFromFragment(this._content, 'mcs-auto-optimize-objective', 'div');
        this._searchTrials = getElementFromFragment(this._content, 'mcs-auto-optimize-search-trials', 'input');
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

    public connectedCallback() {
        this.appendChild(this._content);

        // __MCS_BUILD__ is a build-time literal (webpack DefinePlugin) — no runtime Global access, so
        // this is safe even though connectedCallback can run during setup before Global.context exists.
        this._build.textContent = `Build: ${__MCS_BUILD__}`;

        this._searchTrials.value = String(Global.stores.optimizer.state.searchTrials);
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

        PageController.on(id => {
            if (id === PageId.AutoOptimize) {
                this._refreshObjective();
                this._renderLocks();
            }
        });

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

        this._objective.innerHTML = `
            <div><strong>Objective:</strong> ${plot.text}${unit} (${direction})</div>
            <div><strong>Target:</strong> ${targetName}</div>
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
        return buildDimensions(applier, new GameCandidateProvider(true));
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
        Global.stores.optimizer.set({ searchTrials });

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

        const applier = new GameLoadoutApplier();
        // Score with batch-means variance, then memoize. BatchingScorer splits each evaluation into B
        // sub-runs to estimate the metric's standard error, which the optimizer's significance gate
        // uses to avoid recommending noise-level swaps. The cache wraps it (keyed by the applied
        // Settings snapshot) so convergence-pass repeats are served without re-simming.
        const scorer = new MemoizingScorer(
            new BatchingScorer(this._scorer),
            () => stableStringify(applier.snapshot())
        );
        // Keep every dimension in the array (so locked slots still render in the live grid); locked
        // ones are wrapped so the search never varies them.
        this._runDims = buildDimensions(applier, new GameCandidateProvider(true)).map(dim =>
            this._lockedDims.has(dim.id) ? lockedDimension(dim) : dim
        );
        // Estimate total work up front (candidates × passes) to drive the progress bar + ETA.
        this._estimatedEvals = this._estimateEvals();
        this._startTime = Date.now();
        const optimizer = new CoordinateAscentOptimizer(scorer, this._runDims, applier);
        const sim = Global.stores.simulator.state;

        try {
            const result = await optimizer.run(
                target,
                {
                    searchTrials,
                    // Ticks are the per-kill budget, not a "search is cheaper" knob — cutting them
                    // below the user's Simulate setting starves slow kills and fails every sim
                    // (baseline included) for any target that needs >searchTicks to die. Speed comes
                    // from fewer trials; never let the search tick budget drop below sim.ticks.
                    searchTicks: Math.max(Global.stores.optimizer.state.searchTicks, sim.ticks),
                    finalTrials: sim.trials,
                    finalTicks: sim.ticks
                },
                progress => this._renderProgress(progress),
                cancel,
                event => this._onEvent(event)
            );
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
        this._leaderboardMap.clear();
        this._leaderboardSig = '';
        this._latest = undefined;
        this._baselineLoadout = undefined;
        this._feed.innerHTML = '';
        this._leaderboard.innerHTML = '';
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
                feasible: event.feasible
            });
        }

        this._latest = event;
        if (event.type === 'best-improved') {
            this._appendFeed(event);
        }
        this._scheduleRender();
    }

    /** Coalesce live-grid + leaderboard repaints to one per animation frame (events can be bursty). */
    private _scheduleRender() {
        if (this._renderScheduled) {
            return;
        }
        this._renderScheduled = true;
        requestAnimationFrame(() => {
            this._renderScheduled = false;
            this._flushRender();
        });
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
        entries.forEach((entry, index) => {
            const loadout = choicesToLoadout(this._runDims, entry.choices);
            const row = createElement('div', { classList: ['mcs-ao-entry'] });

            const rank = createElement('div', { classList: ['mcs-ao-entry-rank'], text: `#${index + 1}` });
            const icons = loadoutRow(loadout, { diffFrom: this._baselineLoadout, showEmpty: true });

            const metricText = Number.isFinite(entry.metric) ? `${this._format(entry.metric)}${this._metricUnit()}` : '—';
            const death = entry.feasible ? '' : ` ☠${(entry.deathRate * 100).toFixed(0)}%`;
            const metric = createElement('div', {
                classList: entry.feasible ? ['mcs-ao-entry-metric'] : ['mcs-ao-entry-metric', 'mcs-ao-infeasible'],
                text: metricText + death
            });

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
        const best = Number.isFinite(progress.bestMetric) ? this._format(progress.bestMetric) : '—';
        // The slot counter is only meaningful while searching; finalize/done emit slotIndex == slotCount.
        const slotPart =
            progress.phase === 'searching'
                ? `slot ${Math.min(progress.slotIndex + 1, progress.slotCount)}/${progress.slotCount} · `
                : '';
        this._progress.textContent =
            `${this._phaseLabel(progress.phase)} · pass ${progress.pass} · ` +
            slotPart +
            `evals ${progress.evaluations} · best ${best}`;

        const done = progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'aborted';
        this._updateProgressBar(progress.evaluations, done);
    }

    /**
     * Rough upfront estimate of total evaluations: candidates per (searchable) dimension × max passes,
     * plus the baseline + final re-score. An over-estimate (searches usually converge before maxPasses),
     * so the ETA errs long and the bar jumps to 100% on completion rather than stalling past it.
     */
    private _estimateEvals(): number {
        const perPass = this._runDims.reduce((sum, dim) => sum + Math.max(0, dim.getCandidates().length - 1), 0);
        return Math.max(1, perPass * DEFAULT_OPTIONS.maxPasses + 2);
    }

    private _updateProgressBar(evaluations: number, done: boolean) {
        const fraction = done ? 1 : Math.min(0.99, evaluations / this._estimatedEvals);
        this._progressBarFill.style.width = `${(fraction * 100).toFixed(1)}%`;

        if (done) {
            this._progressEta.textContent = 'done';
            return;
        }

        const elapsed = Date.now() - this._startTime;
        if (evaluations > 0 && elapsed > 0) {
            const perEval = elapsed / evaluations;
            const remaining = Math.max(0, this._estimatedEvals - evaluations) * perEval;
            this._progressEta.textContent = `ETA ${this._formatEta(remaining)}`;
        } else {
            this._progressEta.textContent = '';
        }
    }

    private _formatEta(ms: number): string {
        const seconds = Math.max(0, Math.ceil(ms / 1000));
        if (seconds < 60) {
            return `~${seconds}s`;
        }
        return `~${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
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

        const baseline = this._format(result.baselineMetric);
        const best = this._format(result.bestMetric);

        let html = `<div><strong>Baseline:</strong> ${baseline}</div><div><strong>Best:</strong> ${best}</div>`;

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
}

customElements.define('mcs-auto-optimize', AutoOptimizePage);
