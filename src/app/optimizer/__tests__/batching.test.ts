import { describe, expect, it } from 'vitest';
import { meanStdError } from 'src/app/optimizer/statistics';
import { BatchingScorer } from 'src/app/optimizer/batching';
import { Evaluation, OptimizeTarget, Scorer } from 'src/app/optimizer/types';

const TARGET: OptimizeTarget = { monsterId: 'test:Dummy' };

/** Deterministic PRNG so batching tests are reproducible. */
function mulberry32(seed: number): () => number {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('meanStdError', () => {
    it('computes the sample mean and standard error', () => {
        // samples [2,4,6]: mean 4, sample sd 2, stderr 2/√3.
        const { mean, stdError, n } = meanStdError([2, 4, 6]);
        expect(mean).toBe(4);
        expect(n).toBe(3);
        expect(stdError).toBeCloseTo(2 / Math.sqrt(3), 10);
    });

    it('returns NaN stderr for a single sample (spread is unknowable)', () => {
        expect(meanStdError([5]).stdError).toBeNaN();
    });

    it('drops non-finite samples', () => {
        const { mean, n } = meanStdError([2, NaN, 4, Infinity]);
        expect(n).toBe(2);
        expect(mean).toBe(3);
    });

    it('handles empty input', () => {
        expect(meanStdError([]).mean).toBeNaN();
    });
});

/** A stochastic scorer: metric = base + uniform noise of half-width `spread`, deathRate 0. */
class NoisyScorer implements Scorer {
    public calls = 0;
    constructor(private readonly base: number, private readonly spread: number, private readonly rng = mulberry32(1)) {}
    public async evaluate(): Promise<Evaluation> {
        this.calls++;
        return { metric: this.base + (this.rng() * 2 - 1) * this.spread, deathRate: 0, success: true };
    }
    public isMaximize() {
        return true;
    }
}

describe('BatchingScorer', () => {
    it('runs B sub-batches and reports a finite standard error', async () => {
        const inner = new NoisyScorer(100, 20);
        const scorer = new BatchingScorer(inner, 5);
        const e = await scorer.evaluate(TARGET, 100, 1000);
        expect(inner.calls).toBe(5); // one call per batch
        expect(e.metric).toBeGreaterThan(50); // ≈ base 100
        expect(e.metric).toBeLessThan(150);
        expect(e.stdError).toBeGreaterThan(0);
        expect(Number.isFinite(e.stdError!)).toBe(true);
    });

    it('reports a SMALLER standard error for a less noisy scorer', async () => {
        const noisy = await new BatchingScorer(new NoisyScorer(100, 40, mulberry32(7)), 6).evaluate(TARGET, 120, 1000);
        const calm = await new BatchingScorer(new NoisyScorer(100, 2, mulberry32(7)), 6).evaluate(TARGET, 120, 1000);
        expect(calm.stdError!).toBeLessThan(noisy.stdError!);
    });

    it('passes through (no batching, no stdError) when batches <= 1', async () => {
        const inner = new NoisyScorer(100, 20);
        const e = await new BatchingScorer(inner, 1).evaluate(TARGET, 100, 1000);
        expect(inner.calls).toBe(1);
        expect(e.stdError).toBeUndefined();
    });

    it('passes through when there are too few trials to batch meaningfully', async () => {
        const inner = new NoisyScorer(100, 20);
        // 8 trials with minTrialsPerBatch 5 => floor(8/5)=1 batch < 2 => pass-through.
        const e = await new BatchingScorer(inner, 5, 5).evaluate(TARGET, 8, 1000);
        expect(inner.calls).toBe(1);
        expect(e.stdError).toBeUndefined();
    });

    it('splits the trial budget across batches (perBatch = ceil(trials/b))', async () => {
        const seen: number[] = [];
        const spy: Scorer = {
            evaluate: async (_t, trials) => {
                seen.push(trials);
                return { metric: 1, deathRate: 0, success: true };
            },
            isMaximize: () => true
        };
        await new BatchingScorer(spy, 4).evaluate(TARGET, 100, 1000);
        expect(seen).toEqual([25, 25, 25, 25]); // 4 batches of 25
    });

    it('reports infeasible (Infinity death) when every batch fails', async () => {
        const failing: Scorer = {
            evaluate: async () => ({ metric: NaN, deathRate: Infinity, success: false }),
            isMaximize: () => true
        };
        const e = await new BatchingScorer(failing, 4).evaluate(TARGET, 100, 1000);
        expect(e.success).toBe(false);
        expect(e.deathRate).toBe(Infinity);
    });

    it('averages per-batch death rates (a setup that sometimes dies is infeasible)', async () => {
        let call = 0;
        const sometimesDies: Scorer = {
            evaluate: async () => {
                call++;
                return { metric: 10, deathRate: call % 2 === 0 ? 0.2 : 0, success: true };
            },
            isMaximize: () => true
        };
        const e = await new BatchingScorer(sometimesDies, 4).evaluate(TARGET, 100, 1000);
        expect(e.deathRate).toBeGreaterThan(0); // not clean => flagged for the hard constraint
    });
});
