/**
 * Coordinate-ascent setup optimizer.
 *
 * Pure search logic: depends only on the injected {@link Scorer}, {@link Dimension}[] and
 * {@link SetupApplier} interfaces — no game/`Global.*` dependency — so it runs headless under
 * Node with fakes (see `__tests__`). It iterates generic "dimensions" (equipment slots,
 * prayers, potion, food, …), mutating one at a time. See `docs/auto-optimize.md`.
 */
import {
    CancelToken,
    DEFAULT_OPTIONS,
    Dimension,
    DimensionChange,
    DimensionChoice,
    EventCallback,
    Evaluation,
    OptimizeOptions,
    OptimizeResult,
    OptimizeTarget,
    ProgressCallback,
    Scorer,
    SetupApplier
} from 'src/app/optimizer/types';

/** Internal comparable score. Higher is better, with feasibility taking precedence. */
interface Score {
    feasible: boolean;
    /** Directed metric (sign-flipped for minimize objectives); -Infinity if the sim failed. */
    value: number;
    deathRate: number;
    /** Standard error of the metric (Monte-Carlo noise), or 0 if the scorer didn't estimate it. */
    stdError: number;
}

export class CoordinateAscentOptimizer {
    constructor(
        private readonly scorer: Scorer,
        private readonly dimensions: Dimension[],
        private readonly applier: SetupApplier
    ) {}

    public async run(
        target: OptimizeTarget,
        options: Partial<OptimizeOptions> = {},
        onProgress?: ProgressCallback,
        cancel?: CancelToken,
        onEvent?: EventCallback
    ): Promise<OptimizeResult> {
        const opts: OptimizeOptions = { ...DEFAULT_OPTIONS, ...options };
        const dims = this.dimensions;
        const baselineSetup = this.applier.snapshot();
        let evaluations = 0;

        // The most deaths a setup can have and still end feasible is floor(threshold * trials).
        // Once it exceeds that, no number of remaining trials can rescue it, so the sim can abort.
        // (deathRateThreshold 0 => abort on the first death.) Infinity disables the abort entirely.
        const searchAbortThreshold = opts.earlyStopOnDeath
            ? Math.floor(opts.deathRateThreshold * opts.searchTrials) + 1
            : Infinity;
        const screenAbortThreshold = opts.earlyStopOnDeath
            ? Math.floor(opts.deathRateThreshold * opts.screenTrials) + 1
            : Infinity;

        try {
            // Baseline choices (for the diff) + baseline evaluation of the current setup.
            const baselineChoices = dims.map(dim => dim.getCurrentChoice());
            const baseEval = await this.scorer.evaluate(
                target,
                opts.searchTrials,
                opts.searchTicks,
                searchAbortThreshold
            );
            evaluations++;
            let bestScore = this.toScore(baseEval, opts.deathRateThreshold);
            const baselineMetric = baseEval.metric;
            const baselineDeath = baseEval.deathRate;
            let incumbentSnap = this.applier.snapshot();

            // Per-dimension choices of the incumbent (the best setup so far). Updated at each commit.
            // Lets the optimizer emit a full choice list per evaluation (incumbent + one swap) for the
            // UI to render — cheap, no game reads. `setup` snapshots carry the conflict-resolved truth.
            let incumbentChoices: DimensionChoice[] = baselineChoices.slice();

            const emitEvent = (
                type: 'evaluated' | 'best-improved',
                changedIndex: number,
                choices: DimensionChoice[],
                evaluation: Evaluation,
                setup?: unknown
            ) =>
                onEvent?.({
                    type,
                    choices,
                    changedIndex,
                    metric: evaluation.metric,
                    deathRate: evaluation.deathRate,
                    feasible: this.toScore(evaluation, opts.deathRateThreshold).feasible,
                    evaluations,
                    setup
                });

            // The baseline is the first point on the leaderboard / live view.
            emitEvent('evaluated', -1, incumbentChoices, baseEval, incumbentSnap);

            const emit = (
                phase: OptimizeResult['status'] | 'searching' | 'finalizing',
                pass: number,
                dimIndex: number,
                dimId: string
            ) =>
                onProgress?.({
                    phase: phase === 'completed' ? 'done' : phase,
                    pass,
                    slotIndex: dimIndex,
                    slotCount: dims.length,
                    slotId: dimId,
                    evaluations,
                    bestMetric:
                        bestScore.value === -Infinity ? NaN : this.scorer.isMaximize() ? bestScore.value : -bestScore.value,
                    baselineMetric
                });

            let cancelled = false;

            for (let pass = 1; pass <= opts.maxPasses && !cancelled; pass++) {
                let improvedThisPass = false;

                for (let i = 0; i < dims.length; i++) {
                    if (cancel?.cancelled) {
                        cancelled = true;
                        break;
                    }
                    const dim = dims[i];
                    this.applier.restore(incumbentSnap);
                    const currentChoice = dim.getCurrentChoice();
                    emit('searching', pass, i, dim.id);

                    let bestChoice = currentChoice;
                    let bestDimScore = bestScore;
                    let bestDimEval: Evaluation | undefined;

                    // Candidates other than "leave as-is" (already represented by bestScore).
                    const candidates = dim.getCandidates().filter(c => !dim.equals(c, currentChoice));

                    // Evaluate one candidate on top of the incumbent at a given fidelity.
                    const evalChoice = async (choice: DimensionChoice, trials: number, abort: number) => {
                        // Reset to the incumbent so each candidate is judged in isolation
                        // (also handles equipment 2H/shield/ammo coupling deterministically).
                        this.applier.restore(incumbentSnap);
                        dim.applyChoice(choice);
                        const evaluation = await this.scorer.evaluate(target, trials, opts.searchTicks, abort);
                        evaluations++;
                        // Emit the evaluated candidate (incumbent with this one dimension swapped) so
                        // the UI can show it live and rank it on a leaderboard.
                        const candidateChoices = incumbentChoices.slice();
                        candidateChoices[i] = choice;
                        emitEvent('evaluated', i, candidateChoices, evaluation);
                        return { score: this.toScore(evaluation, opts.deathRateThreshold), evaluation };
                    };

                    // Adaptive trials (§2e): screen all candidates cheaply, then confirm only the best
                    // `screenKeep` at full fidelity. Skipped (confirm everything) when disabled or when
                    // there aren't enough candidates to be worth a screen pass.
                    let toConfirm = candidates;
                    if (
                        opts.screenTrials > 0 &&
                        opts.screenTrials < opts.searchTrials &&
                        opts.screenKeep > 0 &&
                        candidates.length > opts.screenKeep
                    ) {
                        const screened: { choice: DimensionChoice; score: Score }[] = [];
                        for (const choice of candidates) {
                            screened.push({ choice, score: (await evalChoice(choice, opts.screenTrials, screenAbortThreshold)).score });
                            if (cancel?.cancelled) {
                                cancelled = true;
                                break;
                            }
                        }
                        // Best-first by the same ordering as the accept test, then keep the top K.
                        screened.sort((a, b) => (this.better(a.score, b.score, 0) ? -1 : this.better(b.score, a.score, 0) ? 1 : 0));
                        toConfirm = screened.slice(0, opts.screenKeep).map(s => s.choice);
                    }

                    for (const choice of toConfirm) {
                        if (cancel?.cancelled) {
                            cancelled = true;
                            break;
                        }
                        const { score, evaluation } = await evalChoice(choice, opts.searchTrials, searchAbortThreshold);
                        if (this.better(score, bestDimScore, opts.minImprovement, opts.significanceZ)) {
                            bestDimScore = score;
                            bestChoice = choice;
                            bestDimEval = evaluation;
                        }
                    }

                    if (!dim.equals(bestChoice, currentChoice)) {
                        // Commit the winner, then snapshot the actual (conflict-resolved) setup.
                        this.applier.restore(incumbentSnap);
                        dim.applyChoice(bestChoice);
                        incumbentSnap = this.applier.snapshot();
                        bestScore = bestDimScore;
                        improvedThisPass = true;
                        // Refresh the incumbent's choices from the live state so conflict resolution
                        // (e.g. a 2H weapon clearing the shield slot) is reflected, then announce the
                        // new global best with the accurate snapshot for the UI's "new best" feed.
                        incumbentChoices = dims.map(d => d.getCurrentChoice());
                        if (bestDimEval) {
                            emitEvent('best-improved', i, incumbentChoices, bestDimEval, incumbentSnap);
                        }
                    }
                }

                if (!improvedThisPass) {
                    break; // converged
                }
            }

            // Finalize: re-score the winner at full fidelity (search may have used fewer trials).
            this.applier.restore(incumbentSnap);
            emit('finalizing', opts.maxPasses, dims.length, '');
            // No death-abort on the final re-score: the winner is feasible, so run every trial to
            // report an exact death rate rather than a partial one.
            const finalEval = await this.scorer.evaluate(target, opts.finalTrials, opts.finalTicks);
            evaluations++;

            // Diff: compare baseline choices to the incumbent's choices (live state == incumbent).
            const dimensionDiff: DimensionChange[] = [];
            for (let i = 0; i < dims.length; i++) {
                const dim = dims[i];
                const current = dim.getCurrentChoice();
                const base = baselineChoices[i];
                if (!dim.equals(base, current)) {
                    dimensionDiff.push({
                        dimensionId: dim.id,
                        label: dim.label,
                        from: dim.describe(base),
                        to: dim.describe(current)
                    });
                }
            }

            const result: OptimizeResult = {
                status: cancelled ? 'cancelled' : 'completed',
                baselineSetup,
                bestSetup: incumbentSnap,
                baselineMetric,
                baselineDeathRate: baselineDeath,
                bestMetric: finalEval.metric,
                bestDeathRate: finalEval.deathRate,
                dimensionDiff,
                evaluations,
                improved: dimensionDiff.length > 0
            };
            emit(result.status, opts.maxPasses, dims.length, '');
            return result;
        } finally {
            // Always restore the user's original configuration.
            this.applier.restore(baselineSetup);
        }
    }

    /** Map a raw evaluation to a comparable score. */
    private toScore(evaluation: Evaluation, deathRateThreshold: number): Score {
        const usable = evaluation.success && !Number.isNaN(evaluation.metric);
        const value = !usable ? -Infinity : this.scorer.isMaximize() ? evaluation.metric : -evaluation.metric;
        const feasible = usable && evaluation.deathRate <= deathRateThreshold;
        return {
            feasible,
            value,
            deathRate: usable ? evaluation.deathRate : Infinity,
            // stdError is symmetric under the minimize sign-flip, so the raw value carries over.
            stdError: usable && Number.isFinite(evaluation.stdError) ? (evaluation.stdError as number) : 0
        };
    }

    /**
     * Is `a` strictly better than `b`? Feasibility dominates; among feasible setups the directed
     * metric must clear a noise margin — the larger of the fixed `minImprovement` and a statistical
     * `z × combinedStandardError` band, so a swap that's within Monte-Carlo noise is NOT accepted
     * (status-quo bias). Among infeasible setups, prefer the one closer to surviving (lower death rate).
     */
    private better(a: Score, b: Score, minImprovement: number, significanceZ = 0): boolean {
        if (a.feasible !== b.feasible) {
            return a.feasible;
        }
        if (a.feasible) {
            const significanceMargin = significanceZ * Math.hypot(a.stdError, b.stdError);
            return a.value > b.value + Math.max(minImprovement, significanceMargin);
        }
        return a.deathRate < b.deathRate;
    }
}
