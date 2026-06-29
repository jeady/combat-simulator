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
        cancel?: CancelToken
    ): Promise<OptimizeResult> {
        const opts: OptimizeOptions = { ...DEFAULT_OPTIONS, ...options };
        const dims = this.dimensions;
        const baselineSetup = this.applier.snapshot();
        let evaluations = 0;

        try {
            // Baseline choices (for the diff) + baseline evaluation of the current setup.
            const baselineChoices = dims.map(dim => dim.getCurrentChoice());
            const baseEval = await this.scorer.evaluate(target, opts.searchTrials, opts.searchTicks);
            evaluations++;
            let bestScore = this.toScore(baseEval, opts.deathRateThreshold);
            const baselineMetric = baseEval.metric;
            const baselineDeath = baseEval.deathRate;
            let incumbentSnap = this.applier.snapshot();

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

                    for (const choice of dim.getCandidates()) {
                        if (dim.equals(choice, currentChoice)) {
                            continue; // "leave as-is" is already represented by bestScore
                        }
                        // Reset to the incumbent so each candidate is judged in isolation
                        // (also handles equipment 2H/shield/ammo coupling deterministically).
                        this.applier.restore(incumbentSnap);
                        dim.applyChoice(choice);
                        const evaluation = await this.scorer.evaluate(target, opts.searchTrials, opts.searchTicks);
                        evaluations++;
                        const score = this.toScore(evaluation, opts.deathRateThreshold);
                        if (this.better(score, bestDimScore, opts.minImprovement)) {
                            bestDimScore = score;
                            bestChoice = choice;
                        }
                        if (cancel?.cancelled) {
                            cancelled = true;
                            break;
                        }
                    }

                    if (!dim.equals(bestChoice, currentChoice)) {
                        // Commit the winner, then snapshot the actual (conflict-resolved) setup.
                        this.applier.restore(incumbentSnap);
                        dim.applyChoice(bestChoice);
                        incumbentSnap = this.applier.snapshot();
                        bestScore = bestDimScore;
                        improvedThisPass = true;
                    }
                }

                if (!improvedThisPass) {
                    break; // converged
                }
            }

            // Finalize: re-score the winner at full fidelity (search may have used fewer trials).
            this.applier.restore(incumbentSnap);
            emit('finalizing', opts.maxPasses, dims.length, '');
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
        return { feasible, value, deathRate: usable ? evaluation.deathRate : Infinity };
    }

    /**
     * Is `a` strictly better than `b`? Feasibility dominates; among feasible setups the directed
     * metric decides (with a noise-guard margin); among infeasible ones, prefer the one closer to
     * surviving (lower death rate).
     */
    private better(a: Score, b: Score, minImprovement: number): boolean {
        if (a.feasible !== b.feasible) {
            return a.feasible;
        }
        if (a.feasible) {
            return a.value > b.value + minImprovement;
        }
        return a.deathRate < b.deathRate;
    }
}
