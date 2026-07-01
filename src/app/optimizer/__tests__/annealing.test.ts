import { describe, expect, it } from 'vitest';
import { simulatedAnnealing } from 'src/app/optimizer/annealing';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import { Evaluation, OptimizeTarget, Scorer } from 'src/app/optimizer/types';
import { FakeApplier, FakeCandidateProvider, FakeWorld, TARGET } from 'src/app/optimizer/__tests__/fakes';

/**
 * mulberry32 — a tiny, fast, well-distributed seeded PRNG. We inject this instead of `Math.random`
 * so every annealing run in these tests is fully reproducible (determinism is a hard requirement).
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A SYNERGY-AWARE scorer: the metric is the world's total power PLUS a fixed bonus when a specific
 * PAIR of items is equipped together. This is the emergent synergy that a heuristic (or single-move
 * greedy search) cannot see — only actually simulating the joint setup reveals it. Deliberately
 * defined in the test (not fakes.ts) so the fakes stay synergy-agnostic.
 */
class SynergyScorer implements Scorer {
    public evaluations = 0;
    constructor(
        private readonly world: FakeWorld,
        private readonly synA: string,
        private readonly synB: string,
        private readonly bonus: number,
        private readonly onEvaluate?: (count: number) => void
    ) {}

    public async evaluate(
        _target: OptimizeTarget,
        _trials: number,
        _ticks: number
    ): Promise<Evaluation> {
        this.evaluations++;
        this.onEvaluate?.(this.evaluations);
        const equipped = new Set(this.world.current.values());
        const synergy = equipped.has(this.synA) && equipped.has(this.synB) ? this.bonus : 0;
        return {
            metric: this.world.power() + synergy,
            deathRate: this.world.deathRate(),
            success: true
        };
    }

    public isMaximize(): boolean {
        return true;
    }
}

/**
 * The headline world: two slots, each holding a low-power synergy item (`synA`/`synB`, power 5) and
 * a high-power decoy (power 40). Alone, each decoy dominates its slot, so single-move greedy always
 * picks the decoys (max power 40+40 = 80). But synA+synB together score 5+5+100 = 110 — a joint
 * optimum only reachable by flipping BOTH slots in one move. Start with the decoys so the greedy
 * search has nowhere to climb.
 */
function synergyWorld(): FakeWorld {
    return new FakeWorld(
        ['ring', 'amulet'],
        [
            { id: 'synA', slotId: 'ring', power: 5 },
            { id: 'decoyR', slotId: 'ring', power: 40 },
            { id: 'synB', slotId: 'amulet', power: 5 },
            { id: 'decoyA', slotId: 'amulet', power: 40 }
        ],
        { ring: 'decoyR', amulet: 'decoyA' }
    );
}

function dims(world: FakeWorld) {
    const applier = new FakeApplier(world);
    return { applier, dimensions: equipmentDimensions(applier, new FakeCandidateProvider(world)) };
}

describe('simulatedAnnealing', () => {
    it('finds an emergent synergy that coordinate ascent misses', async () => {
        // (a) Coordinate ascent from the same start: it can only see single-slot swaps. synA alone
        // (5) is worse than the decoy (40) in the ring slot, and likewise for the amulet, so it
        // never adopts either half → it stays on the decoys and never discovers the pair.
        const caWorld = synergyWorld();
        const caApplier = new FakeApplier(caWorld);
        const caScorer = new SynergyScorer(caWorld, 'synA', 'synB', 100);
        const ca = new CoordinateAscentOptimizer(
            caScorer,
            equipmentDimensions(caApplier, new FakeCandidateProvider(caWorld)),
            caApplier
        );
        const caResult = await ca.run(TARGET);
        const caSetup = caResult.bestSetup as Map<string, string>;
        // Greedy stays on the decoys (or at least fails to reach the synergy pair).
        expect(caSetup.get('ring')).toBe('decoyR');
        expect(caSetup.get('amulet')).toBe('decoyA');
        expect(caResult.bestMetric).toBe(80);

        // (b) Annealing from the same start DOES reach the synergy pair via a two-slot move.
        const saWorld = synergyWorld();
        const { applier, dimensions } = dims(saWorld);
        const saScorer = new SynergyScorer(saWorld, 'synA', 'synB', 100);
        const result = await simulatedAnnealing(saScorer, dimensions, applier, TARGET, {
            iterations: 400,
            initialTemperature: 30,
            coolingRate: 0.99,
            maxDimensionsPerMove: 2,
            random: mulberry32(12345)
        });

        const best = result.bestSetup as Map<string, string>;
        expect(best.get('ring')).toBe('synA');
        expect(best.get('amulet')).toBe('synB');
        expect(result.bestMetric).toBe(110);
        expect(result.improved).toBe(true);
    });

    it('never returns an infeasible setup when a feasible one is reachable', async () => {
        // A huge-metric weapon that kills (risk 1) vs a modest survivable one. Feasibility is a hard
        // constraint, so the dying setup must never be reported as best even though its metric wins.
        const world = new FakeWorld(
            ['weapon'],
            [
                { id: 'glass', slotId: 'weapon', power: 1000, risk: 1 },
                { id: 'safe', slotId: 'weapon', power: 20, risk: 0 }
            ],
            { weapon: 'glass' } // start infeasible
        );
        const { applier, dimensions } = dims(world);
        const scorer = new SynergyScorer(world, 'none', 'none', 0);

        const result = await simulatedAnnealing(scorer, dimensions, applier, TARGET, {
            iterations: 200,
            random: mulberry32(7)
        });

        const best = result.bestSetup as Map<string, string>;
        expect(best.get('weapon')).toBe('safe');
        expect(result.bestDeathRate).toBe(0);
        expect(result.improved).toBe(true);
    });

    it('restores the original world state afterward', async () => {
        const world = synergyWorld();
        const { applier, dimensions } = dims(world);
        const scorer = new SynergyScorer(world, 'synA', 'synB', 100);

        await simulatedAnnealing(scorer, dimensions, applier, TARGET, {
            iterations: 200,
            random: mulberry32(99)
        });

        // The live world must equal the original start regardless of what was explored.
        expect(world.current.get('ring')).toBe('decoyR');
        expect(world.current.get('amulet')).toBe('decoyA');
        expect(world.current.size).toBe(2);
    });

    it('is deterministic under a fixed seed', async () => {
        const run = async () => {
            const world = synergyWorld();
            const { applier, dimensions } = dims(world);
            const scorer = new SynergyScorer(world, 'synA', 'synB', 100);
            return simulatedAnnealing(scorer, dimensions, applier, TARGET, {
                iterations: 300,
                initialTemperature: 30,
                random: mulberry32(2024)
            });
        };

        const a = await run();
        const b = await run();

        expect(b.bestSetup).toEqual(a.bestSetup);
        expect(b.bestMetric).toBe(a.bestMetric);
        expect(b.bestDeathRate).toBe(a.bestDeathRate);
        expect(b.evaluations).toBe(a.evaluations);
        expect(b.improved).toBe(a.improved);
    });

    it('honors cancellation', async () => {
        const world = synergyWorld();
        const { applier, dimensions } = dims(world);
        const cancel = { cancelled: false };
        // Cancel after a handful of evaluations.
        const scorer = new SynergyScorer(world, 'synA', 'synB', 100, count => {
            if (count >= 5) {
                cancel.cancelled = true;
            }
        });

        const result = await simulatedAnnealing(
            scorer,
            dimensions,
            applier,
            TARGET,
            { iterations: 100000, random: mulberry32(1) },
            undefined,
            cancel
        );

        expect(result.status).toBe('cancelled');
        // Stopped promptly rather than running all 100000 iterations.
        expect(scorer.evaluations).toBeLessThan(50);
    });
});
