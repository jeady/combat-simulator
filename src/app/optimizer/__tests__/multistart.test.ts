import { describe, expect, it } from 'vitest';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import { multiStart, Seed } from 'src/app/optimizer/multistart';
import { OptimizeEvent, OptimizeProgress } from 'src/app/optimizer/types';
import { cancelToken, FakeApplier, FakeCandidateProvider, FakeScorer, FakeWorld, TARGET } from 'src/app/optimizer/__tests__/fakes';

/**
 * Wire an optimizer + the pieces multiStart needs over a given world. We return the applier and
 * scorer too because multiStart is injected with the SAME applier the optimizer uses (to install
 * seeds) and the scorer (only for direction).
 */
function build(world: FakeWorld, scorer = new FakeScorer(world)) {
    const applier = new FakeApplier(world);
    const optimizer = new CoordinateAscentOptimizer(
        scorer,
        equipmentDimensions(applier, new FakeCandidateProvider(world)),
        applier
    );
    return { optimizer, applier, scorer };
}

/**
 * Build a seed by applying a concrete loadout to the world, snapshotting it, then restoring the
 * world (so building seeds is side-effect-free). The snapshot is the opaque token multiStart hands
 * back to `restore`.
 */
function seedFromLoadout(world: FakeWorld, applier: FakeApplier, id: string, loadout: Record<string, string>): Seed {
    const saved = applier.snapshot();
    applier.applyLoadout(new Map(Object.entries(loadout)));
    const snapshot = applier.snapshot();
    applier.restore(saved);
    return { id, snapshot };
}

const setup = (result: { bestSetup: unknown }) => result.bestSetup as Map<string, string>;

describe('multiStart', () => {
    /**
     * THE HEADLINE TEST — escaping a cold-start local optimum via coupled slots.
     *
     * Landscape (weapon + shield, coupled by a 2H weapon that clears the shield):
     *   sword   : 1H weapon, power 10
     *   gs      : 2H weapon, power 50, clears the shield slot
     *   shield1 : shield,    power 45
     *
     * Global optimum: sword(10) + shield1(45) = 55.   Trap optimum: gs alone = 50.
     *
     * Trap seed starts with the shield slot EMPTY. Greedy coordinate ascent moves the weapon slot
     * first: from an empty-shield start, gs(50) beats sword(10), so it equips the 2H weapon — which
     * clears the shield slot and forecloses the 55 basin. Re-adding the shield would unequip gs
     * (45 < 50), so the search is stuck at 50. A single run from this seed CANNOT reach 55.
     *
     * The other seed starts already in the sword+shield1 basin (55); from there gs(50) is a
     * downgrade, so it stays put and converges at the global optimum. Multi-start keeps the best of
     * the two and returns 55.
     */
    it('escapes a local optimum a single start cannot (coupled slots)', async () => {
        const items = [
            { id: 'sword', slotId: 'weapon', power: 10 },
            { id: 'gs', slotId: 'weapon', power: 50, clearsSlots: ['shield'] },
            { id: 'shield1', slotId: 'shield', power: 45 }
        ];
        const world = new FakeWorld(['weapon', 'shield'], items, { weapon: 'sword' });
        const { optimizer, applier, scorer } = build(world);

        const trapSeed = seedFromLoadout(world, applier, 'trap', { weapon: 'sword' });
        const goodSeed = seedFromLoadout(world, applier, 'good', { weapon: 'sword', shield: 'shield1' });

        // Baseline: a single run from the trap seed alone gets stuck at 50.
        applier.restore(trapSeed.snapshot);
        const trapOnly = await optimizer.run(TARGET);
        expect(trapOnly.bestMetric).toBe(50);
        expect(setup(trapOnly).get('weapon')).toBe('gs');
        expect(setup(trapOnly).has('shield')).toBe(false);

        // Multi-start over both seeds reaches the global optimum 55.
        const ms = await multiStart(optimizer, applier, scorer, TARGET, [trapSeed, goodSeed]);
        expect(ms.best.bestMetric).toBe(55);
        expect(ms.bestSeedId).toBe('good');
        expect(setup(ms.best).get('weapon')).toBe('sword');
        expect(setup(ms.best).get('shield')).toBe('shield1');
    });

    it('returns the best of N seeds by metric', async () => {
        // Reuse the coupled weapon/shield landscape so seeds genuinely converge to DIFFERENT optima
        // (a single trivial slot would let every seed reach the same global best, making the winning
        // seed id ambiguous). gs(50) clears the shield; sword(10)+shield1(45)=55 is the global best.
        const items = [
            { id: 'sword', slotId: 'weapon', power: 10 },
            { id: 'gs', slotId: 'weapon', power: 50, clearsSlots: ['shield'] },
            { id: 'shield1', slotId: 'shield', power: 45 }
        ];
        const world = new FakeWorld(['weapon', 'shield'], items, { weapon: 'sword' });
        const { optimizer, applier, scorer } = build(world);

        const seeds: Seed[] = [
            seedFromLoadout(world, applier, 's_trap_a', { weapon: 'gs' }), // converges to 50
            seedFromLoadout(world, applier, 's_best', { weapon: 'sword', shield: 'shield1' }), // 55
            seedFromLoadout(world, applier, 's_trap_b', { weapon: 'sword' }) // converges to 50
        ];

        const ms = await multiStart(optimizer, applier, scorer, TARGET, seeds);

        expect(ms.best.bestMetric).toBe(55);
        expect(ms.bestSeedId).toBe('s_best');
        expect(ms.seedSummaries).toHaveLength(3);
        expect(ms.seedSummaries.map(s => s.bestMetric)).toEqual([50, 55, 50]);
        expect(ms.seedSummaries.every(s => s.feasible)).toBe(true);
    });

    it('restores the original world state after running (snapshot/restore integrity)', async () => {
        const items = [
            { id: 'w1', slotId: 'weapon', power: 10 },
            { id: 'w2', slotId: 'weapon', power: 99 }
        ];
        const world = new FakeWorld(['weapon'], items, { weapon: 'w1' });
        const { optimizer, applier, scorer } = build(world);

        const seeds: Seed[] = [
            seedFromLoadout(world, applier, 'a', { weapon: 'w1' }),
            seedFromLoadout(world, applier, 'b', { weapon: 'w2' })
        ];

        await multiStart(optimizer, applier, scorer, TARGET, seeds);

        // The live world must equal the ORIGINAL start, not any seed or any optimum found.
        expect(world.current.get('weapon')).toBe('w1');
        expect(world.current.size).toBe(1);
    });

    it('feasibility dominates: a lower-metric feasible seed beats a higher-metric dying seed', async () => {
        // Two slots whose ONLY items are: a dying weapon and a safe amulet. Key fact: the optimizer
        // can swap an item but never UNequip a slot (no candidate is `null`), so once the weapon slot
        // holds glass it is stuck there — glass is the slot's only candidate. That makes each seed a
        // genuine fixed point, so the cross-seed feasibility tie-break is what decides the winner.
        //   glass : weapon, power 1000, risk 1.0  (always dies; the only weapon item)
        //   safe  : amulet, power 30,   risk 0
        // glass seed -> {weapon: glass}: adding the amulet doesn't lower risk (still 1.0), so it stays
        // infeasible at 1000. safe seed -> {amulet: safe}: equipping glass would raise the metric but
        // DIES, so feasibility keeps it at 30, alive. The feasible 30 must beat the infeasible 1000.
        const items = [
            { id: 'glass', slotId: 'weapon', power: 1000, risk: 1 },
            { id: 'safe', slotId: 'amulet', power: 30, risk: 0 }
        ];
        const world = new FakeWorld(['weapon', 'amulet'], items, { amulet: 'safe' });
        const { optimizer, applier, scorer } = build(world);

        const glassSeed = seedFromLoadout(world, applier, 'glass', { weapon: 'glass' });
        const safeSeed = seedFromLoadout(world, applier, 'safe', { amulet: 'safe' });

        const ms = await multiStart(optimizer, applier, scorer, TARGET, [glassSeed, safeSeed]);

        // The dying seed has a far higher metric but is infeasible, so the safe seed wins.
        expect(ms.bestSeedId).toBe('safe');
        expect(ms.best.bestMetric).toBe(30);
        expect(ms.best.bestDeathRate).toBe(0);
        const glassSummary = ms.seedSummaries.find(s => s.id === 'glass');
        expect(glassSummary?.feasible).toBe(false);
        expect(glassSummary?.bestDeathRate).toBe(1);
    });

    it('respects minimize direction (smaller metric wins)', async () => {
        // One item per slot, so (since the optimizer can only swap, never unequip) each seed is locked
        // to the single item it starts with: adding the OTHER slot's item only raises the summed metric,
        // which a minimize search rejects. That keeps the basins distinct so the direction decides.
        //   f9 in slot s1 (power 9),  f2 in slot s2 (power 2)
        const items = [
            { id: 'f9', slotId: 's1', power: 9 },
            { id: 'f2', slotId: 's2', power: 2 } // cheapest -> best when minimizing
        ];
        const world = new FakeWorld(['s1', 's2'], items, { s1: 'f9' });
        const { optimizer, applier, scorer } = build(world, new FakeScorer(world, { maximize: false }));

        const seeds: Seed[] = [
            seedFromLoadout(world, applier, 's_hi', { s1: 'f9' }), // converges to 9
            seedFromLoadout(world, applier, 's_lo', { s2: 'f2' }) // converges to 2
        ];

        const ms = await multiStart(optimizer, applier, scorer, TARGET, seeds);

        // Minimizing: the seed whose converged metric is smallest must win.
        expect(ms.bestSeedId).toBe('s_lo');
        expect(ms.best.bestMetric).toBe(2);
        expect(ms.seedSummaries.map(s => s.bestMetric)).toEqual([9, 2]);
    });

    it('stops launching seeds once cancelled', async () => {
        const items = [{ id: 'w1', slotId: 'weapon', power: 10 }];
        const world = new FakeWorld(['weapon'], items, { weapon: 'w1' });
        const cancel = cancelToken();
        // Cancel during the very first seed's run.
        const scorer = new FakeScorer(world, { onEvaluate: () => { cancel.cancelled = true; } });
        const { optimizer, applier } = build(world, scorer);

        const seeds: Seed[] = [
            seedFromLoadout(world, applier, 'first', { weapon: 'w1' }),
            seedFromLoadout(world, applier, 'second', { weapon: 'w1' })
        ];

        const ms = await multiStart(optimizer, applier, scorer, TARGET, seeds, {}, undefined, cancel);

        expect(ms.cancelled).toBe(true);
        // Only the first seed should have been launched; the second was skipped.
        expect(ms.seedSummaries).toHaveLength(1);
        expect(ms.seedSummaries[0].id).toBe('first');
    });

    it('reports per-seed summaries and emits per-seed progress', async () => {
        const items = [
            { id: 'w1', slotId: 'weapon', power: 10 },
            { id: 'w2', slotId: 'weapon', power: 20 }
        ];
        const world = new FakeWorld(['weapon'], items, { weapon: 'w1' });
        const { optimizer, applier, scorer } = build(world);

        const seeds: Seed[] = [
            seedFromLoadout(world, applier, 'a', { weapon: 'w1' }),
            seedFromLoadout(world, applier, 'b', { weapon: 'w2' })
        ];
        const progress: { seedIndex: number; seedCount: number; seedId: string }[] = [];

        const ms = await multiStart(optimizer, applier, scorer, TARGET, seeds, {}, p => progress.push(p));

        expect(ms.seedSummaries).toHaveLength(2);
        expect(progress.map(p => p.seedId)).toEqual(['a', 'b']);
        expect(progress.every(p => p.seedCount === 2)).toBe(true);
    });

    it('forwards optimizer events and per-pass progress from every seed (A6)', async () => {
        const items = [
            { id: 'w1', slotId: 'weapon', power: 10 },
            { id: 'w2', slotId: 'weapon', power: 20 }
        ];
        const world = new FakeWorld(['weapon'], items, { weapon: 'w1' });
        const { optimizer, applier, scorer } = build(world);

        const seeds: Seed[] = [
            seedFromLoadout(world, applier, 'a', { weapon: 'w1' }),
            seedFromLoadout(world, applier, 'b', { weapon: 'w2' })
        ];
        const seedProgress: { seedId: string }[] = [];
        const optimizerProgress: OptimizeProgress[] = [];
        const events: OptimizeEvent[] = [];

        await multiStart(
            optimizer,
            applier,
            scorer,
            TARGET,
            seeds,
            {},
            p => seedProgress.push(p),
            undefined,
            p => optimizerProgress.push(p),
            e => events.push(e)
        );

        // Every seed's inner run emitted events (at least a baseline 'evaluated' each) and per-pass
        // progress; the per-seed progress callback is unchanged (one entry per seed).
        expect(seedProgress.map(p => p.seedId)).toEqual(['a', 'b']);
        expect(events.filter(e => e.changedIndex === -1).length).toBe(2); // one baseline per seed
        expect(optimizerProgress.length).toBeGreaterThan(0);
        expect(optimizerProgress.some(p => p.phase === 'searching')).toBe(true);
    });

    it('throws when given no seeds', async () => {
        const world = new FakeWorld(['weapon'], [{ id: 'w1', slotId: 'weapon', power: 10 }], { weapon: 'w1' });
        const { optimizer, applier, scorer } = build(world);

        await expect(multiStart(optimizer, applier, scorer, TARGET, [])).rejects.toThrow();
    });
});
