import './auto-optimize.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';
import { PageController, PageId } from 'src/app/user-interface/pages/page-controller';
import { Settings, SettingsController } from 'src/app/settings-controller';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
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
import { CancelToken, OptimizePhase, OptimizeProgress, OptimizeResult, OptimizeTarget } from 'src/app/optimizer/types';
import { Lookup } from 'src/shared/utils/lookup';

// Injected at build time by webpack DefinePlugin (see webpack.config.ts) so the page can show which
// build is actually loaded — the surest way to confirm a freshly built modfile took effect.
declare const __MCS_BUILD__: string;

declare global {
    interface HTMLElementTagNameMap {
        'mcs-auto-optimize': AutoOptimizePage;
    }
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

    private readonly _scorer = new GameScorer();
    private _cancel?: CancelToken;
    private _result?: OptimizeResult;

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
    }

    public connectedCallback() {
        this.appendChild(this._content);

        // __MCS_BUILD__ is a build-time literal (webpack DefinePlugin) — no runtime Global access, so
        // this is safe even though connectedCallback can run during setup before Global.context exists.
        this._build.textContent = `Build: ${__MCS_BUILD__}`;

        this._searchTrials.value = String(Global.stores.optimizer.state.searchTrials);
        this._run.onclick = () => this._onRun();
        this._apply.onclick = () => this._onApply();

        PageController.on(id => {
            if (id === PageId.AutoOptimize) {
                this._refreshObjective();
            }
        });

        this._refreshObjective();
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
        Global.stores.optimizer.set({ isRunning: true });
        this._run.textContent = 'Cancel';
        this._status.textContent = 'Running…';

        const applier = new GameLoadoutApplier();
        const optimizer = new CoordinateAscentOptimizer(
            this._scorer,
            buildDimensions(applier, new GameCandidateProvider(true)),
            applier
        );
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
                cancel
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
    }

    private _renderResult(result: OptimizeResult) {
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

    private _slotName(slotId: string): string {
        // Equipment slots don't expose a clean display name; strip the namespace and humanize.
        const local = slotId.includes(':') ? slotId.split(':')[1] : slotId;
        return local.replace(/_/g, ' ');
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
