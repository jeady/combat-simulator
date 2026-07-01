/**
 * Batch-means variance estimation (§ significance) as a {@link Scorer} decorator.
 *
 * A single simulation returns a point estimate of the objective with no idea how noisy it is. To let
 * the optimizer tell a real improvement from Monte-Carlo noise, we need the estimate's standard
 * error. This decorator splits a scorer's `trials` into B independent batches, runs each, and reports
 * the mean of the per-batch metrics plus their standard error (batch means). It's metric-agnostic
 * (the inner scorer computes whatever objective is selected) and composes with any scorer, so it's
 * verifiable headless against the real engine.
 *
 * Ordering with the cache: wrap as `MemoizingScorer(BatchingScorer(realScorer))` — the cache keys on
 * the full `trials` and stores the batched {mean, stdError}, while BatchingScorer fans each miss out
 * into B sub-runs.
 *
 * Caveat: the B batches are independent sub-runs (each starts a fresh fight sequence), so cross-kill
 * continuity (slowly bleeding HP over a long fight) isn't captured in the *variance* estimate — fine
 * for throughput metrics; survivability is still enforced by the hard death constraint on each batch.
 */
import { Evaluation, OptimizeTarget, Scorer } from 'src/app/optimizer/types';
import { meanStdError } from 'src/app/optimizer/statistics';

export class BatchingScorer implements Scorer {
    constructor(
        private readonly inner: Scorer,
        /** Number of batches to split the trials into. ≤1 disables batching (pass-through). */
        private readonly batches = 5,
        /** Don't batch below this many trials per batch — too few to be meaningful. */
        private readonly minTrialsPerBatch = 5
    ) {}

    public async evaluate(
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        // How many batches actually fit? Need ≥2 for a standard error, and each ≥ minTrialsPerBatch.
        const b = Math.min(this.batches, Math.floor(trials / this.minTrialsPerBatch));
        if (this.batches <= 1 || b < 2) {
            return this.inner.evaluate(target, trials, ticks, deathAbortThreshold); // pass-through, no stdError
        }

        const perBatch = Math.ceil(trials / b);
        const metrics: number[] = [];
        const deathRates: number[] = [];
        let anySuccess = false;

        for (let i = 0; i < b; i++) {
            // Each batch keeps the same death-abort threshold: for the common 0-tolerance case that's
            // "abort on the first death", which still fires within a batch. A batch that dies yields a
            // positive death rate, so the setup reads infeasible regardless of the metric.
            const e = await this.inner.evaluate(target, perBatch, ticks, deathAbortThreshold);
            if (e.success && Number.isFinite(e.metric)) {
                metrics.push(e.metric);
                anySuccess = true;
            }
            if (Number.isFinite(e.deathRate)) {
                deathRates.push(e.deathRate);
            }
        }

        if (!anySuccess) {
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        const { mean, stdError } = meanStdError(metrics);
        // Equal-size batches => mean of per-batch death rates == the pooled rate.
        const deathRate = deathRates.length > 0 ? deathRates.reduce((s, r) => s + r, 0) / deathRates.length : Infinity;
        return {
            metric: mean,
            deathRate,
            success: true,
            stdError: Number.isFinite(stdError) ? stdError : undefined
        };
    }

    public isMaximize(): boolean {
        return this.inner.isMaximize();
    }
}
