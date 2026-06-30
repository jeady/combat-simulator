import { describe, expect, it } from 'vitest';
import { MemoizingScorer, stableStringify } from 'src/app/optimizer/cache';
import { Evaluation, OptimizeTarget, Scorer } from 'src/app/optimizer/types';

const TARGET: OptimizeTarget = { monsterId: 'test:Dummy' };

/** A Scorer that counts real evaluations and returns a per-call-distinct, key-independent metric. */
class CountingScorer implements Scorer {
    public calls = 0;
    constructor(private readonly maximize = true) {}
    public async evaluate(): Promise<Evaluation> {
        this.calls++;
        // Distinct metric per call so a served cache hit (same value as the first call) is detectable.
        return { metric: this.calls, deathRate: 0, success: true };
    }
    public isMaximize(): boolean {
        return this.maximize;
    }
}

describe('MemoizingScorer', () => {
    it('serves a repeated (same setup, same params) evaluation from cache', async () => {
        const inner = new CountingScorer();
        let key = 'setupA';
        const scorer = new MemoizingScorer(inner, () => key);

        const first = await scorer.evaluate(TARGET, 100, 1000);
        const second = await scorer.evaluate(TARGET, 100, 1000);

        expect(inner.calls).toBe(1); // only one real simulation
        expect(second).toEqual(first); // identical memoized result
        expect(scorer.hits).toBe(1);
        expect(scorer.misses).toBe(1);
        expect(scorer.size).toBe(1);
    });

    it('misses when the applied setup changes', async () => {
        const inner = new CountingScorer();
        let key = 'setupA';
        const scorer = new MemoizingScorer(inner, () => key);

        await scorer.evaluate(TARGET, 100, 1000);
        key = 'setupB';
        await scorer.evaluate(TARGET, 100, 1000);

        expect(inner.calls).toBe(2);
        expect(scorer.misses).toBe(2);
        expect(scorer.hits).toBe(0);
    });

    it('does not serve a search-time entry for the higher-fidelity final re-score (trials differ)', async () => {
        const inner = new CountingScorer();
        const scorer = new MemoizingScorer(inner, () => 'setupA');

        await scorer.evaluate(TARGET, 200, 1000); // search
        await scorer.evaluate(TARGET, 1000, 1000); // final re-score, same setup

        expect(inner.calls).toBe(2); // distinct keys => fresh simulation
    });

    it('keys on the death-abort threshold (a partial result must not serve a full evaluation)', async () => {
        const inner = new CountingScorer();
        const scorer = new MemoizingScorer(inner, () => 'setupA');

        await scorer.evaluate(TARGET, 200, 1000, 1); // aborting search eval
        await scorer.evaluate(TARGET, 200, 1000, Infinity); // non-aborting
        await scorer.evaluate(TARGET, 200, 1000); // undefined threshold

        expect(inner.calls).toBe(3);
    });

    it('keys on the target (different monster/entity => fresh simulation)', async () => {
        const inner = new CountingScorer();
        const scorer = new MemoizingScorer(inner, () => 'setupA');

        await scorer.evaluate({ monsterId: 'm1' }, 200, 1000);
        await scorer.evaluate({ monsterId: 'm2' }, 200, 1000);
        await scorer.evaluate({ monsterId: 'm1', entityId: 'dungeon1' }, 200, 1000);

        expect(inner.calls).toBe(3);
    });

    it('delegates the objective direction to the inner scorer', () => {
        expect(new MemoizingScorer(new CountingScorer(false), () => 'k').isMaximize()).toBe(false);
        expect(new MemoizingScorer(new CountingScorer(true), () => 'k').isMaximize()).toBe(true);
    });

    describe('stableStringify (cache-key serialization)', () => {
        it('distinguishes Maps that differ (JSON.stringify would collapse both to {})', () => {
            const a = new Map([['weapon', 'bronze']]);
            const b = new Map([['weapon', 'steel']]);
            expect(stableStringify(a)).not.toBe(stableStringify(b));
            // Sanity: a plain stringify really does collide here (the bug this guards against).
            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        });

        it('is insertion-order independent for Maps (equal setups => identical key)', () => {
            const a = new Map([['weapon', 'steel'], ['shield', 'wooden']]);
            const b = new Map([['shield', 'wooden'], ['weapon', 'steel']]);
            expect(stableStringify(a)).toBe(stableStringify(b));
        });

        it('handles nested Maps (e.g. Settings.skillTreeIds: Map<string, Map<...>>)', () => {
            const a = { trees: new Map([['t1', new Map([['n', ['a', 'b']]])]]) };
            const b = { trees: new Map([['t1', new Map([['n', ['a', 'c']]])]]) };
            expect(stableStringify(a)).not.toBe(stableStringify(b));
        });

        it('serializes Sets order-independently', () => {
            expect(stableStringify(new Set(['b', 'a']))).toBe(stableStringify(new Set(['a', 'b'])));
            expect(stableStringify(new Set(['a']))).not.toBe(stableStringify(new Set(['a', 'b'])));
        });
    });

    it('clear() drops cached results and resets counters', async () => {
        const inner = new CountingScorer();
        const scorer = new MemoizingScorer(inner, () => 'setupA');

        await scorer.evaluate(TARGET, 100, 1000);
        await scorer.evaluate(TARGET, 100, 1000);
        expect(scorer.hits).toBe(1);

        scorer.clear();
        expect(scorer.size).toBe(0);
        expect(scorer.hits).toBe(0);
        expect(scorer.misses).toBe(0);

        await scorer.evaluate(TARGET, 100, 1000);
        expect(inner.calls).toBe(2); // re-simulated after clear
    });
});
