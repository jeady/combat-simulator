import { describe, expect, it } from 'vitest';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import { OptimizeProgress, OptimizeResult } from 'src/app/optimizer/types';
import { cancelToken, FakeApplier, FakeCandidateProvider, FakeScorer, FakeWorld, TARGET } from 'src/app/optimizer/__tests__/fakes';

function build(world: FakeWorld, scorer = new FakeScorer(world)) {
    const applier = new FakeApplier(world);
    const optimizer = new CoordinateAscentOptimizer(
        scorer,
        equipmentDimensions(applier, new FakeCandidateProvider(world)),
        applier
    );
    return { optimizer, scorer };
}

/** The fake's snapshot IS the equipment map, so read the best loadout straight off bestSetup. */
const setup = (result: OptimizeResult) => result.bestSetup as Map<string, string>;

describe('CoordinateAscentOptimizer', () => {
    it('reaches the known optimum across multiple slots', async () => {
        const world = new FakeWorld(
            ['weapon', 'body'],
            [
                { id: 'w1', slotId: 'weapon', power: 10 },
                { id: 'w2', slotId: 'weapon', power: 20 },
                { id: 'w3', slotId: 'weapon', power: 15 },
                { id: 'b1', slotId: 'body', power: 5 },
                { id: 'b2', slotId: 'body', power: 8 }
            ],
            { weapon: 'w1', body: 'b1' }
        );
        const { optimizer } = build(world);

        const result = await optimizer.run(TARGET);

        expect(result.status).toBe('completed');
        expect(result.improved).toBe(true);
        expect(setup(result).get('weapon')).toBe('w2');
        expect(setup(result).get('body')).toBe('b2');
        expect(result.bestMetric).toBe(28);
        expect(result.dimensionDiff).toHaveLength(2);
    });

    it('treats death rate as a hard constraint (rejects a stronger but dying loadout)', async () => {
        const world = new FakeWorld(
            ['weapon'],
            [
                { id: 'safe', slotId: 'weapon', power: 10, risk: 0 },
                { id: 'strong', slotId: 'weapon', power: 100, risk: 0.5 } // higher metric, but dies
            ],
            { weapon: 'safe' }
        );
        const { optimizer } = build(world);

        const result = await optimizer.run(TARGET);

        expect(setup(result).get('weapon')).toBe('safe');
        expect(result.improved).toBe(false);
        expect(result.bestDeathRate).toBe(0);
    });

    it('escapes an infeasible start toward a surviving loadout', async () => {
        const world = new FakeWorld(
            ['weapon'],
            [
                { id: 'dying', slotId: 'weapon', power: 100, risk: 1 },
                { id: 'survives', slotId: 'weapon', power: 30, risk: 0 }
            ],
            { weapon: 'dying' }
        );
        const { optimizer } = build(world);

        const result = await optimizer.run(TARGET);

        expect(setup(result).get('weapon')).toBe('survives');
        expect(result.bestDeathRate).toBe(0);
        expect(result.improved).toBe(true);
    });

    it('minimizes when the objective direction is minimize', async () => {
        const world = new FakeWorld(
            ['food'],
            [
                { id: 'a1', slotId: 'food', power: 5 },
                { id: 'a2', slotId: 'food', power: 2 }, // lowest "cost" wins when minimizing
                { id: 'a3', slotId: 'food', power: 9 }
            ],
            { food: 'a1' }
        );
        const { optimizer } = build(world, new FakeScorer(world, { maximize: false }));

        const result = await optimizer.run(TARGET);

        expect(setup(result).get('food')).toBe('a2');
        expect(result.bestMetric).toBe(2);
    });

    it('restores the original loadout after running (snapshot/restore integrity)', async () => {
        const world = new FakeWorld(
            ['weapon', 'body'],
            [
                { id: 'w1', slotId: 'weapon', power: 10 },
                { id: 'w2', slotId: 'weapon', power: 99 },
                { id: 'b1', slotId: 'body', power: 5 }
            ],
            { weapon: 'w1', body: 'b1' }
        );
        const { optimizer } = build(world);

        await optimizer.run(TARGET);

        // The world's live state must equal the original start, regardless of the best found.
        expect(world.current.get('weapon')).toBe('w1');
        expect(world.current.get('body')).toBe('b1');
        expect(world.current.size).toBe(2);
    });

    it('handles 2H/offhand conflict and reports the conflict-resolved loadout', async () => {
        const world = new FakeWorld(
            ['weapon', 'shield'],
            [
                { id: 'sword', slotId: 'weapon', power: 5 },
                { id: 'greatsword', slotId: 'weapon', power: 30, clearsSlots: ['shield'] },
                { id: 'shield1', slotId: 'shield', power: 3 }
            ],
            { weapon: 'sword', shield: 'shield1' }
        );
        const { optimizer } = build(world);

        const result = await optimizer.run(TARGET);

        // greatsword (30) beats sword+shield (5+3=8); equipping it clears the shield slot.
        expect(setup(result).get('weapon')).toBe('greatsword');
        expect(setup(result).has('shield')).toBe(false);
        expect(result.bestMetric).toBe(30);
    });

    it('stops promptly when cancelled and reports cancelled status', async () => {
        const world = new FakeWorld(
            ['weapon', 'body', 'legs'],
            [
                { id: 'w1', slotId: 'weapon', power: 1 },
                { id: 'w2', slotId: 'weapon', power: 2 },
                { id: 'b1', slotId: 'body', power: 1 },
                { id: 'b2', slotId: 'body', power: 2 },
                { id: 'l1', slotId: 'legs', power: 1 },
                { id: 'l2', slotId: 'legs', power: 2 }
            ],
            { weapon: 'w1', body: 'b1', legs: 'l1' }
        );
        const cancel = cancelToken();
        // Cancel after a handful of evaluations.
        const scorer = new FakeScorer(world, { onEvaluate: count => { if (count >= 3) cancel.cancelled = true; } });
        const { optimizer } = build(world, scorer);

        const result = await optimizer.run(TARGET, {}, undefined, cancel);

        expect(result.status).toBe('cancelled');
        // Should not have evaluated the full cross-product of candidates.
        expect(scorer.evaluations).toBeLessThan(8);
    });

    it('converges without changes when the start is already optimal', async () => {
        const world = new FakeWorld(
            ['weapon'],
            [
                { id: 'best', slotId: 'weapon', power: 50 },
                { id: 'worse', slotId: 'weapon', power: 10 }
            ],
            { weapon: 'best' }
        );
        const { optimizer, scorer } = build(world);

        const result = await optimizer.run(TARGET);

        expect(result.improved).toBe(false);
        expect(result.dimensionDiff).toHaveLength(0);
        // 1 baseline + 1 candidate ('worse') + 1 finalize = 3; passes stop after no improvement.
        expect(scorer.evaluations).toBeLessThanOrEqual(4);
    });

    it('uses the full trial count for the final re-evaluation', async () => {
        const world = new FakeWorld(['weapon'], [{ id: 'w1', slotId: 'weapon', power: 10 }], { weapon: 'w1' });
        const { optimizer, scorer } = build(world);

        await optimizer.run(TARGET, { searchTrials: 50, finalTrials: 5000 });

        expect(scorer.lastTrials).toBe(5000);
    });

    it('keeps a feasible setup over a higher-metric one that dies (maximize, hard constraint)', async () => {
        const world = new FakeWorld(
            ['weapon', 'body'],
            [
                { id: 'w_safe', slotId: 'weapon', power: 10, risk: 0 },
                { id: 'w_glass', slotId: 'weapon', power: 1000, risk: 0.3 }, // huge metric, but dies
                { id: 'b_safe', slotId: 'body', power: 5, risk: 0 },
                { id: 'b_glass', slotId: 'body', power: 1000, risk: 0.3 }
            ],
            { weapon: 'w_safe', body: 'b_safe' }
        );
        const { optimizer } = build(world);

        const result = await optimizer.run(TARGET);

        // Feasibility dominates the metric: the dying pieces are never adopted despite 100x metric.
        expect(setup(result).get('weapon')).toBe('w_safe');
        expect(setup(result).get('body')).toBe('b_safe');
        expect(result.bestDeathRate).toBe(0);
        expect(result.improved).toBe(false);
    });

    it('keeps a feasible setup over a lower-cost one that dies (minimize, hard constraint)', async () => {
        // Minimize objective: smaller power = better. The cheapest option also dies, so feasibility
        // must still win over the better (smaller) metric.
        const world = new FakeWorld(
            ['weapon'],
            [
                { id: 'cheap_dies', slotId: 'weapon', power: 1, risk: 0.5 }, // best metric, but infeasible
                { id: 'safe', slotId: 'weapon', power: 9, risk: 0 }
            ],
            { weapon: 'safe' }
        );
        const { optimizer } = build(world, new FakeScorer(world, { maximize: false }));

        const result = await optimizer.run(TARGET);

        expect(setup(result).get('weapon')).toBe('safe');
        expect(result.bestDeathRate).toBe(0);
    });

    describe('death-abort threshold wiring', () => {
        const single = () =>
            new FakeWorld(['weapon'], [{ id: 'only', slotId: 'weapon', power: 10 }], { weapon: 'only' });

        it('passes "abort on first death" by default, but never on the final re-score', async () => {
            const { optimizer, scorer } = build(single());

            await optimizer.run(TARGET); // defaults: earlyStopOnDeath true, deathRateThreshold 0

            // floor(0 * 200) + 1 === 1 on every search eval; the final re-score must not abort.
            const search = scorer.deathAbortThresholds.slice(0, -1);
            const final = scorer.deathAbortThresholds.at(-1);
            expect(search.length).toBeGreaterThan(0);
            expect(search.every(t => t === 1)).toBe(true);
            expect(final).toBeUndefined();
        });

        it('derives the sound threshold from a non-zero death-rate tolerance', async () => {
            const { optimizer, scorer } = build(single());

            await optimizer.run(TARGET, { deathRateThreshold: 0.05, searchTrials: 200 });

            // floor(0.05 * 200) + 1 === 11: a setup is only certainly infeasible past 10 deaths.
            const search = scorer.deathAbortThresholds.slice(0, -1);
            expect(search.every(t => t === 11)).toBe(true);
        });

        it('disables the abort (Infinity) when earlyStopOnDeath is false', async () => {
            const { optimizer, scorer } = build(single());

            await optimizer.run(TARGET, { earlyStopOnDeath: false });

            const search = scorer.deathAbortThresholds.slice(0, -1);
            expect(search.every(t => t === Infinity)).toBe(true);
        });
    });

    it('emits progress updates', async () => {
        const world = new FakeWorld(
            ['weapon'],
            [{ id: 'w1', slotId: 'weapon', power: 10 }, { id: 'w2', slotId: 'weapon', power: 20 }],
            { weapon: 'w1' }
        );
        const { optimizer } = build(world);
        const updates: OptimizeProgress[] = [];

        await optimizer.run(TARGET, {}, p => updates.push(p));

        expect(updates.length).toBeGreaterThan(0);
        expect(updates.some(u => u.phase === 'searching')).toBe(true);
        expect(updates.some(u => u.phase === 'done')).toBe(true);
    });
});
