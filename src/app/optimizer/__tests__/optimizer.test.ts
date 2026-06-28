import { describe, expect, it } from 'vitest';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { OptimizeProgress } from 'src/app/optimizer/types';
import { cancelToken, FakeApplier, FakeCandidateProvider, FakeScorer, FakeWorld, TARGET } from 'src/app/optimizer/__tests__/fakes';

function build(world: FakeWorld, scorer = new FakeScorer(world)) {
    const optimizer = new CoordinateAscentOptimizer(scorer, new FakeCandidateProvider(world), new FakeApplier(world));
    return { optimizer, scorer };
}

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
        expect(result.best.loadout.get('weapon')).toBe('w2');
        expect(result.best.loadout.get('body')).toBe('b2');
        expect(result.best.metric).toBe(28);
        expect(result.diff).toHaveLength(2);
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

        expect(result.best.loadout.get('weapon')).toBe('safe');
        expect(result.improved).toBe(false);
        expect(result.best.deathRate).toBe(0);
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

        expect(result.best.loadout.get('weapon')).toBe('survives');
        expect(result.best.deathRate).toBe(0);
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

        expect(result.best.loadout.get('food')).toBe('a2');
        expect(result.best.metric).toBe(2);
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
        expect(result.best.loadout.get('weapon')).toBe('greatsword');
        expect(result.best.loadout.has('shield')).toBe(false);
        expect(result.best.metric).toBe(30);
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
        expect(result.diff).toHaveLength(0);
        // 1 baseline + 1 candidate ('worse') + 1 finalize = 3; passes stop after no improvement.
        expect(scorer.evaluations).toBeLessThanOrEqual(4);
    });

    it('uses the full trial count for the final re-evaluation', async () => {
        const world = new FakeWorld(['weapon'], [{ id: 'w1', slotId: 'weapon', power: 10 }], { weapon: 'w1' });
        const { optimizer, scorer } = build(world);

        await optimizer.run(TARGET, { searchTrials: 50, finalTrials: 5000 });

        expect(scorer.lastTrials).toBe(5000);
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
