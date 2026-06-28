/**
 * Coordinate-ascent gear optimizer.
 *
 * Pure search logic: depends only on the injected {@link Scorer}, {@link CandidateProvider}
 * and {@link LoadoutApplier} interfaces — no game/`Global.*` dependency — so it runs headless
 * under Node with fakes (see `__tests__`). See `docs/auto-optimize.md` and the P1 plan.
 */
import {
    CancelToken,
    CandidateProvider,
    DEFAULT_OPTIONS,
    EquipmentLoadout,
    Evaluation,
    LoadoutApplier,
    OptimizeOptions,
    OptimizeResult,
    OptimizeTarget,
    ProgressCallback,
    Scorer,
    SlotChange
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
        private readonly candidates: CandidateProvider,
        private readonly applier: LoadoutApplier
    ) {}

    public async run(
        target: OptimizeTarget,
        options: Partial<OptimizeOptions> = {},
        onProgress?: ProgressCallback,
        cancel?: CancelToken
    ): Promise<OptimizeResult> {
        const opts: OptimizeOptions = { ...DEFAULT_OPTIONS, ...options };
        const slots = this.applier.slots();
        const snap = this.applier.snapshot();
        let evaluations = 0;

        try {
            // Baseline: the user's current loadout. Keep a frozen copy for the final diff.
            let incumbent = this.applier.getCurrentLoadout();
            const baselineLoadout = new Map(incumbent);
            this.applier.applyLoadout(incumbent);
            const baseEval = await this.scorer.evaluate(target, opts.searchTrials, opts.searchTicks);
            evaluations++;
            let bestScore = this.toScore(baseEval, opts.deathRateThreshold);
            const baselineMetric = baseEval.metric;
            const baselineDeath = baseEval.deathRate;

            const emit = (phase: OptimizeResult['status'] | 'searching' | 'finalizing', pass: number, slotIndex: number, slotId: string) =>
                onProgress?.({
                    phase: phase === 'completed' ? 'done' : phase,
                    pass,
                    slotIndex,
                    slotCount: slots.length,
                    slotId,
                    evaluations,
                    bestMetric: bestScore.value === -Infinity ? NaN : (this.scorer.isMaximize() ? bestScore.value : -bestScore.value),
                    baselineMetric
                });

            let cancelled = false;

            for (let pass = 1; pass <= opts.maxPasses && !cancelled; pass++) {
                let improvedThisPass = false;

                for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
                    if (cancel?.cancelled) {
                        cancelled = true;
                        break;
                    }
                    const slotId = slots[slotIndex].id;
                    const currentItem = incumbent.get(slotId);
                    emit('searching', pass, slotIndex, slotId);

                    let bestItem = currentItem;
                    let bestSlotScore = bestScore;

                    for (const candidateId of this.candidates.getCandidates(slotId)) {
                        if (candidateId === currentItem) {
                            continue; // "leave as-is" is already represented by bestScore
                        }
                        // Re-apply the incumbent first so each candidate is judged in isolation
                        // (handles 2H/shield and weapon/ammo coupling deterministically).
                        this.applier.applyLoadout(incumbent);
                        this.applier.equip(slotId, candidateId);
                        const evaluation = await this.scorer.evaluate(target, opts.searchTrials, opts.searchTicks);
                        evaluations++;
                        const score = this.toScore(evaluation, opts.deathRateThreshold);
                        if (this.better(score, bestSlotScore, opts.minImprovement)) {
                            bestSlotScore = score;
                            bestItem = candidateId;
                        }
                        if (cancel?.cancelled) {
                            cancelled = true;
                            break;
                        }
                    }

                    if (bestItem !== currentItem) {
                        // Commit the winner, then read back the actual (conflict-resolved) loadout.
                        this.applier.applyLoadout(incumbent);
                        if (bestItem !== undefined) {
                            this.applier.equip(slotId, bestItem);
                        }
                        incumbent = this.applier.getCurrentLoadout();
                        bestScore = bestSlotScore;
                        improvedThisPass = true;
                    }
                }

                if (!improvedThisPass) {
                    break; // converged
                }
            }

            // Finalize: re-score the winner at full fidelity (search may have used fewer trials).
            this.applier.applyLoadout(incumbent);
            emit('finalizing', opts.maxPasses, slots.length, '');
            const finalEval = await this.scorer.evaluate(target, opts.finalTrials, opts.finalTicks);
            evaluations++;

            const result: OptimizeResult = {
                status: cancelled ? 'cancelled' : 'completed',
                baseline: { loadout: baselineLoadout, metric: baselineMetric, deathRate: baselineDeath },
                best: { loadout: incumbent, metric: finalEval.metric, deathRate: finalEval.deathRate },
                diff: this.diff(baselineLoadout, incumbent),
                evaluations,
                improved: this.isImprovement(baselineLoadout, incumbent)
            };
            emit(result.status, opts.maxPasses, slots.length, '');
            return result;
        } finally {
            // Always restore the user's original configuration.
            this.applier.restore(snap);
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
     * Is `a` strictly better than `b`? Feasibility dominates; among feasible loadouts the
     * directed metric decides (with a noise-guard margin); among infeasible ones, prefer the
     * one closer to surviving (lower death rate).
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

    private diff(from: EquipmentLoadout, to: EquipmentLoadout): SlotChange[] {
        const changes: SlotChange[] = [];
        const slotIds = new Set<string>([...from.keys(), ...to.keys()]);
        for (const slotId of slotIds) {
            const fromItemId = from.get(slotId);
            const toItemId = to.get(slotId);
            if (fromItemId !== toItemId) {
                changes.push({ slotId, fromItemId, toItemId });
            }
        }
        return changes;
    }

    private isImprovement(from: EquipmentLoadout, to: EquipmentLoadout): boolean {
        return this.diff(from, to).length > 0;
    }
}
