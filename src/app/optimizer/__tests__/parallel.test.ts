import { describe, expect, it } from 'vitest';
import { parallelMap } from 'src/app/optimizer/parallel';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('parallelMap', () => {
    it('returns results in INPUT order, not completion order', async () => {
        // Earlier items resolve later, so completion order is reversed from input order.
        const out = await parallelMap([1, 2, 3, 4], 4, async (n, i) => {
            for (let t = 0; t < (4 - i); t++) await tick();
            return n * 10;
        });
        expect(out).toEqual([10, 20, 30, 40]);
    });

    it('never exceeds the concurrency limit', async () => {
        let active = 0;
        let peak = 0;
        const items = Array.from({ length: 20 }, (_, i) => i);
        await parallelMap(items, 4, async n => {
            active++;
            peak = Math.max(peak, active);
            await tick();
            await tick();
            active--;
            return n;
        });
        expect(peak).toBe(4); // saturates but never exceeds
    });

    it('runs sequentially when concurrency is 1', async () => {
        let active = 0;
        let peak = 0;
        await parallelMap([1, 2, 3], 1, async n => {
            active++;
            peak = Math.max(peak, active);
            await tick();
            active--;
            return n;
        });
        expect(peak).toBe(1);
    });

    it('caps concurrency at the item count (no idle over-scheduling)', async () => {
        let active = 0;
        let peak = 0;
        await parallelMap([1, 2], 8, async n => {
            active++;
            peak = Math.max(peak, active);
            await tick();
            active--;
            return n;
        });
        expect(peak).toBe(2);
    });

    it('handles an empty input', async () => {
        expect(await parallelMap([], 4, async () => 1)).toEqual([]);
    });

    it('processes every item exactly once', async () => {
        const items = Array.from({ length: 50 }, (_, i) => i);
        const seen = new Set<number>();
        const out = await parallelMap(items, 7, async n => {
            seen.add(n);
            return n * 2;
        });
        expect(seen.size).toBe(50);
        expect(out).toEqual(items.map(n => n * 2));
    });

    it('rejects if a task rejects', async () => {
        await expect(
            parallelMap([1, 2, 3], 2, async n => {
                if (n === 2) throw new Error('boom');
                return n;
            })
        ).rejects.toThrow('boom');
    });

    it('treats a zero/negative concurrency as 1 (never deadlocks)', async () => {
        expect(await parallelMap([1, 2, 3], 0, async n => n)).toEqual([1, 2, 3]);
    });
});
