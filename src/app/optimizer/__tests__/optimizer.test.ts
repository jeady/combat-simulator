import { describe, expect, it } from 'vitest';
import { CoordinateAscentOptimizer, ladderEvalCount } from 'src/app/optimizer/optimizer';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import { OptimizeEvent, OptimizeProgress, OptimizeResult, OptimizeTarget } from 'src/app/optimizer/types';
import {
    cancelToken,
    FakeApplier,
    FakeBatchScorer,
    FakeCandidateProvider,
    FakeScorer,
    FakeWorld,
    InflatedFirstScorer,
    LateDeathScorer,
    TARGET
} from 'src/app/optimizer/__tests__/fakes';

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

/** Build with the empty/unequip candidate enabled (equipmentDimensions `includeEmpty`). */
function buildWithEmpty(world: FakeWorld, scorer = new FakeScorer(world)) {
    const applier = new FakeApplier(world);
    const optimizer = new CoordinateAscentOptimizer(
        scorer,
        equipmentDimensions(applier, new FakeCandidateProvider(world), undefined, undefined, true),
        applier
    );
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

    it('empties a slot when unequipping beats every item (includeEmpty)', async () => {
        // The only item for the slot is a net-negative "cursed" trinket; leaving the slot empty
        // (metric 0) beats wearing it (metric -50). Without includeEmpty the search could only swap.
        const world = new FakeWorld(
            ['trinket'],
            [{ id: 'cursed', slotId: 'trinket', power: -50 }],
            { trinket: 'cursed' }
        );
        const { optimizer } = buildWithEmpty(world);

        const result = await optimizer.run(TARGET);

        expect(setup(result).has('trinket')).toBe(false); // unequipped
        expect(result.bestMetric).toBe(0);
        expect(result.improved).toBe(true);
    });

    it('does not offer the empty candidate unless includeEmpty is set (regression guard)', async () => {
        const world = new FakeWorld(
            ['trinket'],
            [{ id: 'cursed', slotId: 'trinket', power: -50 }],
            { trinket: 'cursed' }
        );
        const { optimizer } = build(world); // default: no empty candidate

        const result = await optimizer.run(TARGET);

        // Can't unequip, and there's no better item, so it's stuck with the cursed trinket.
        expect(setup(result).get('trinket')).toBe('cursed');
        expect(result.bestMetric).toBe(-50);
    });

    describe('adaptive trials (§2e screen→confirm)', () => {
        // 5 weapon candidates; only the best few should reach full trials.
        const world = () =>
            new FakeWorld(
                ['weapon'],
                [
                    { id: 'w1', slotId: 'weapon', power: 1 },
                    { id: 'w2', slotId: 'weapon', power: 2 },
                    { id: 'w3', slotId: 'weapon', power: 3 },
                    { id: 'w4', slotId: 'weapon', power: 9 }, // the winner
                    { id: 'w5', slotId: 'weapon', power: 4 }
                ],
                { weapon: 'w1' }
            );

        it('still finds the true optimum when screening', async () => {
            const { optimizer } = build(world());
            const result = await optimizer.run(TARGET, { searchTrials: 100, screenTrials: 10, screenKeep: 2, finalTrials: 500 });
            expect(setup(result).get('weapon')).toBe('w4');
        });

        it('screens losers cheaply and confirms only the top screenKeep at full trials', async () => {
            const { optimizer, scorer } = build(world());
            // maxPasses 1 so we count exactly one screen→confirm pass over the slot (a 2nd
            // convergence pass would re-screen it and double these counts).
            await optimizer.run(TARGET, { searchTrials: 100, screenTrials: 10, screenKeep: 2, finalTrials: 500, maxPasses: 1 });

            const screens = scorer.trialsSeen.filter(t => t === 10).length;
            const fullTrialEvals = scorer.trialsSeen.filter(t => t === 100).length;
            // 4 non-current candidates screened (w2..w5); w1 is current and skipped.
            expect(screens).toBe(4);
            // Full-trial (100) evals = the baseline (1) + only screenKeep (2) confirmed candidates.
            expect(fullTrialEvals).toBe(3);
            // And the final re-score used the full finalTrials.
            expect(scorer.trialsSeen).toContain(500);
        });

        it('does not screen when candidates are within screenKeep (no benefit)', async () => {
            const small = new FakeWorld(
                ['weapon'],
                [{ id: 'w1', slotId: 'weapon', power: 1 }, { id: 'w2', slotId: 'weapon', power: 5 }],
                { weapon: 'w1' }
            );
            const { optimizer, scorer } = build(small);
            await optimizer.run(TARGET, { searchTrials: 100, screenTrials: 10, screenKeep: 3 });
            // 2 candidates ≤ screenKeep(3): no screen pass, so no 10-trial evaluations.
            expect(scorer.trialsSeen).not.toContain(10);
        });
    });

    describe('statistical significance gating', () => {
        /** A scorer that reports a fixed metric AND a fixed stdError for whatever is equipped. */
        class NoisyScorer extends FakeScorer {
            constructor(w: FakeWorld, private readonly stdError: number) {
                super(w);
            }
            public async evaluate(t: OptimizeTarget, trials: number, ticks: number, abort?: number) {
                const base = await super.evaluate(t, trials, ticks, abort);
                return { ...base, stdError: this.stdError };
            }
        }

        it('does NOT swap when the improvement is within noise (z·SE)', async () => {
            // Candidate is nominally better (11 vs 10) but SE=5 makes the gap statistically insignificant.
            const world = new FakeWorld(
                ['weapon'],
                [{ id: 'cur', slotId: 'weapon', power: 10 }, { id: 'noise', slotId: 'weapon', power: 11 }],
                { weapon: 'cur' }
            );
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                new NoisyScorer(world, 5),
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );

            const result = await optimizer.run(TARGET, { significanceZ: 1.645 });

            expect(setup(result).get('weapon')).toBe('cur'); // stayed put — the gain was noise
            expect(result.improved).toBe(false);
        });

        it('DOES swap when the improvement clears the significance band', async () => {
            // Same SE=5, but now a decisively better candidate (100 vs 10): 90 >> 1.645·√(25+25).
            const world = new FakeWorld(
                ['weapon'],
                [{ id: 'cur', slotId: 'weapon', power: 10 }, { id: 'real', slotId: 'weapon', power: 100 }],
                { weapon: 'cur' }
            );
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                new NoisyScorer(world, 5),
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );

            const result = await optimizer.run(TARGET, { significanceZ: 1.645 });

            expect(setup(result).get('weapon')).toBe('real');
        });

        it('with significanceZ 0, the tiny gain IS taken (guard disabled)', async () => {
            const world = new FakeWorld(
                ['weapon'],
                [{ id: 'cur', slotId: 'weapon', power: 10 }, { id: 'noise', slotId: 'weapon', power: 11 }],
                { weapon: 'cur' }
            );
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                new NoisyScorer(world, 5),
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );

            const result = await optimizer.run(TARGET, { significanceZ: 0 });

            expect(setup(result).get('weapon')).toBe('noise');
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

    it('emits an evaluated event per candidate plus a best-improved event on each commit', async () => {
        const world = new FakeWorld(
            ['weapon', 'body'],
            [
                { id: 'w1', slotId: 'weapon', power: 10 },
                { id: 'w2', slotId: 'weapon', power: 20 }, // weapon upgrade
                { id: 'b1', slotId: 'body', power: 5 },
                { id: 'b2', slotId: 'body', power: 8 } // body upgrade
            ],
            { weapon: 'w1', body: 'b1' }
        );
        const { optimizer } = build(world);
        const events: OptimizeEvent[] = [];

        const result = await optimizer.run(TARGET, {}, undefined, undefined, e => events.push(e));

        // The baseline + each non-incumbent candidate is announced as 'evaluated'.
        const evaluated = events.filter(e => e.type === 'evaluated');
        expect(evaluated.length).toBeGreaterThan(0);
        // Baseline first, with changedIndex -1 and the starting loadout.
        expect(evaluated[0].changedIndex).toBe(-1);
        expect(evaluated[0].choices).toEqual(['w1', 'b1']);

        // Each commit (weapon then body) yields a best-improved with the accurate snapshot + choices.
        const best = events.filter(e => e.type === 'best-improved');
        expect(best).toHaveLength(2);
        expect(best.map(e => e.metric)).toEqual([25, 28]); // w2+b1, then w2+b2
        expect(best.at(-1)!.choices).toEqual(['w2', 'b2']);
        expect(best.at(-1)!.setup).toEqual(result.bestSetup);
        // changedIndex points at a real dimension on every event.
        expect(events.every(e => e.changedIndex >= -1)).toBe(true);
    });

    it('carries feasibility on events and never emits best-improved for a dying setup', async () => {
        const world = new FakeWorld(
            ['weapon'],
            [
                { id: 'safe', slotId: 'weapon', power: 10, risk: 0 },
                { id: 'glass', slotId: 'weapon', power: 100, risk: 0.5 } // higher metric, but dies
            ],
            { weapon: 'safe' }
        );
        const { optimizer } = build(world);
        const events: OptimizeEvent[] = [];

        await optimizer.run(TARGET, {}, undefined, undefined, e => events.push(e));

        const glass = events.find(e => e.choices[0] === 'glass');
        expect(glass?.feasible).toBe(false);
        // The dying upgrade is never adopted, so no commit / best-improved fires.
        expect(events.some(e => e.type === 'best-improved')).toBe(false);
    });

    describe('confirm-replicate before committing a swap (A1 winner\'s-curse)', () => {
        // A landscape where the true best is the incumbent: 'cur' (10) truly beats 'lucky' (8). But
        // 'lucky' reports an inflated 12 on its FIRST look, which would beat 'cur' if committed on that
        // lucky sample. A fresh replicate reveals the true 8, so the swap must be rejected.
        const luckyWorld = () =>
            new FakeWorld(
                ['weapon'],
                [
                    { id: 'cur', slotId: 'weapon', power: 10 },
                    { id: 'lucky', slotId: 'weapon', power: 8 }
                ],
                { weapon: 'cur' }
            );

        function buildInflated(world: FakeWorld) {
            const scorer = new InflatedFirstScorer(world, 'lucky', 4); // 8 + 4 = 12 on first look
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                scorer,
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );
            return { optimizer, scorer };
        }

        it('REJECTS a spurious swap when confirmSwaps is on (the replicate reveals the true value)', async () => {
            const { optimizer, scorer } = buildInflated(luckyWorld());

            const result = await optimizer.run(TARGET, { confirmSwaps: true, significanceZ: 0 });

            expect(setup(result).get('weapon')).toBe('cur'); // stayed put — the 12 didn't replicate
            expect(result.improved).toBe(false);
            expect(scorer.freshEvaluations).toBe(1); // the one confirm replicate
        });

        it('ACCEPTS the spurious swap when confirmSwaps is off (no replicate guard)', async () => {
            const { optimizer, scorer } = buildInflated(luckyWorld());

            const result = await optimizer.run(TARGET, { confirmSwaps: false, significanceZ: 0 });

            // Without the replicate, the lucky 12 sample is committed even though the truth is 8.
            expect(setup(result).get('weapon')).toBe('lucky');
            expect(result.improved).toBe(true);
            expect(scorer.freshEvaluations).toBe(0); // no fresh replicate was requested
        });

        it('an improving dimension costs exactly one extra evaluation (the replicate)', async () => {
            // A genuine upgrade: 'up' (20) truly beats 'cur' (10), and stays better on replicate.
            const world = new FakeWorld(
                ['weapon'],
                [
                    { id: 'cur', slotId: 'weapon', power: 10 },
                    { id: 'up', slotId: 'weapon', power: 20 }
                ],
                { weapon: 'cur' }
            );
            const scorer = new InflatedFirstScorer(world, 'none', 0); // no inflation
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                scorer,
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );

            const result = await optimizer.run(TARGET, { confirmSwaps: true, maxPasses: 1, significanceZ: 0 });

            expect(setup(result).get('weapon')).toBe('up');
            // Eval accounting: 1 baseline + 1 candidate ('up') + 1 confirm replicate + 1 finalize = 4.
            // The +1 replicate is charged once per committed swap.
            expect(scorer.evaluations).toBe(4);
            expect(scorer.freshEvaluations).toBe(1);
        });

        it('commits with the replicate score, not the lucky sample', async () => {
            // 'up' truly is 20 but reports an inflated 30 on first look; the replicate returns 20.
            const world = new FakeWorld(
                ['weapon'],
                [
                    { id: 'cur', slotId: 'weapon', power: 10 },
                    { id: 'up', slotId: 'weapon', power: 20 }
                ],
                { weapon: 'cur' }
            );
            const scorer = new InflatedFirstScorer(world, 'up', 10); // first look 30, replicate 20
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                scorer,
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );

            const result = await optimizer.run(TARGET, { confirmSwaps: true, maxPasses: 1, significanceZ: 0, finalTrials: 100 });

            expect(setup(result).get('weapon')).toBe('up');
            // The final re-score reads the true world power (20), never the inflated 30.
            expect(result.bestMetric).toBe(20);
        });
    });

    describe('relative-improvement floor (A2)', () => {
        // 'cur' (100) vs a candidate that gains either 1% (101) or 3% (103). No stdError, so the
        // absolute/significance margins are 0 and only the relative floor bites.
        function buildRel(candidatePower: number) {
            const world = new FakeWorld(
                ['weapon'],
                [
                    { id: 'cur', slotId: 'weapon', power: 100 },
                    { id: 'cand', slotId: 'weapon', power: candidatePower }
                ],
                { weapon: 'cur' }
            );
            const applier = new FakeApplier(world);
            const scorer = new FakeScorer(world);
            const optimizer = new CoordinateAscentOptimizer(
                scorer,
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );
            return { optimizer };
        }

        it('rejects a 1% gain at minRelImprovement 0.02', async () => {
            const { optimizer } = buildRel(101);
            const result = await optimizer.run(TARGET, { minRelImprovement: 0.02 });
            expect(setup(result).get('weapon')).toBe('cur');
            expect(result.improved).toBe(false);
        });

        it('accepts a 3% gain at minRelImprovement 0.02', async () => {
            const { optimizer } = buildRel(103);
            const result = await optimizer.run(TARGET, { minRelImprovement: 0.02 });
            expect(setup(result).get('weapon')).toBe('cand');
            expect(result.improved).toBe(true);
        });

        it('takes the MAX of the relative floor and the significance band (not their sum)', async () => {
            // Incumbent 100, candidate 103 (a 3-point gain). Relative floor 0.02·100 = 2 (would pass).
            // But with SE=5 on each, the significance band is 1.645·√(25+25) ≈ 11.6 >> 3, so the swap is
            // rejected: the larger margin (significance) governs, proving max() not sum().
            const world = new FakeWorld(
                ['weapon'],
                [
                    { id: 'cur', slotId: 'weapon', power: 100 },
                    { id: 'cand', slotId: 'weapon', power: 103 }
                ],
                { weapon: 'cur' }
            );
            const applier = new FakeApplier(world);
            class SEScorer extends FakeScorer {
                public async evaluate(t: OptimizeTarget, tr: number, ti: number, ab?: number) {
                    return { ...(await super.evaluate(t, tr, ti, ab)), stdError: 5 };
                }
            }
            const optimizer = new CoordinateAscentOptimizer(
                new SEScorer(world),
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );
            const result = await optimizer.run(TARGET, { minRelImprovement: 0.02, significanceZ: 1.645 });
            expect(setup(result).get('weapon')).toBe('cur'); // significance margin (max) blocks it
        });
    });

    describe('feasibility re-check at final fidelity (A3)', () => {
        it('flags bestFeasible false when the winner dies only at final trials', async () => {
            const world = new FakeWorld(['weapon'], [{ id: 'w1', slotId: 'weapon', power: 10 }], { weapon: 'w1' });
            const applier = new FakeApplier(world);
            // Deathless at searchTrials(200); 5% deaths at the 1000-trial finalize.
            const scorer = new LateDeathScorer(world, 200, 0.05);
            const optimizer = new CoordinateAscentOptimizer(
                scorer,
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );

            const result = await optimizer.run(TARGET, { searchTrials: 200, finalTrials: 1000 });

            expect(result.status).toBe('completed'); // improved semantics unchanged
            expect(result.bestFeasible).toBe(false); // but the recommendation violates the constraint
            expect(result.bestDeathRate).toBe(0.05);
        });

        it('flags bestFeasible true when the winner survives at final fidelity', async () => {
            const world = new FakeWorld(['weapon'], [{ id: 'w1', slotId: 'weapon', power: 10 }], { weapon: 'w1' });
            const { optimizer } = build(world);

            const result = await optimizer.run(TARGET);

            expect(result.bestFeasible).toBe(true);
        });
    });

    describe('uncertainty surfaced in results and events (A5)', () => {
        class SEScorer extends FakeScorer {
            constructor(w: FakeWorld, private readonly se: number) {
                super(w);
            }
            public async evaluate(t: OptimizeTarget, tr: number, ti: number, ab?: number) {
                return { ...(await super.evaluate(t, tr, ti, ab)), stdError: this.se };
            }
        }

        it('populates stdError on events and baseline/best result fields when the scorer supplies it', async () => {
            const world = new FakeWorld(
                ['weapon'],
                [{ id: 'w1', slotId: 'weapon', power: 10 }, { id: 'w2', slotId: 'weapon', power: 20 }],
                { weapon: 'w1' }
            );
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                new SEScorer(world, 2),
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );
            const events: OptimizeEvent[] = [];

            const result = await optimizer.run(TARGET, {}, undefined, undefined, e => events.push(e));

            expect(events.every(e => e.stdError === 2)).toBe(true);
            expect(result.baselineStdError).toBe(2);
            expect(result.bestStdError).toBe(2);
        });

        it('leaves the fields undefined when the scorer does not estimate stdError', async () => {
            const world = new FakeWorld(['weapon'], [{ id: 'w1', slotId: 'weapon', power: 10 }], { weapon: 'w1' });
            const { optimizer } = build(world);
            const events: OptimizeEvent[] = [];

            const result = await optimizer.run(TARGET, {}, undefined, undefined, e => events.push(e));

            expect(events.every(e => e.stdError === undefined)).toBe(true);
            expect(result.baselineStdError).toBeUndefined();
            expect(result.bestStdError).toBeUndefined();
        });

        it('stamps every event with the trial count its evaluation ran at (rungs below searchTrials)', async () => {
            // 6 candidates + screening => a rung at screenTrials(10), then confirms at searchTrials(40).
            const world = new FakeWorld(
                ['weapon'],
                Array.from({ length: 6 }, (_, n) => ({ id: `c${n}`, slotId: 'weapon', power: n })),
                { weapon: 'c0' }
            );
            const { optimizer } = build(world);
            const events: OptimizeEvent[] = [];

            await optimizer.run(
                TARGET,
                { searchTrials: 40, screenTrials: 10, screenKeep: 2 },
                undefined,
                undefined,
                e => events.push(e)
            );

            // Every event carries a fidelity; rung evals are stamped 10, baseline/confirm/replicate 40.
            expect(events.every(e => e.trials === 10 || e.trials === 40)).toBe(true);
            expect(events.some(e => e.trials === 10)).toBe(true);
            // The baseline and the winning (best-improved) entry are full-fidelity — a leaderboard
            // filtering on trials >= searchTrials keeps exactly these, never a screening sample.
            expect(events[0].trials).toBe(40);
            expect(events.filter(e => e.type === 'best-improved').every(e => e.trials === 40)).toBe(true);
        });
    });

    describe('successive-halving ladder (A4)', () => {
        /** A slot with `n` candidates of ascending power (id `cN`, power N), starting on `c0` (power 0). */
        function ladderWorld(n: number) {
            const items = [{ id: 'c0', slotId: 'weapon', power: 0 }];
            for (let i = 1; i <= n; i++) {
                items.push({ id: `c${i}`, slotId: 'weapon', power: i });
            }
            return new FakeWorld(['weapon'], items, { weapon: 'c0' });
        }

        it('races 30 candidates down a rung ladder with the documented eval count', async () => {
            // 30 non-current candidates (c1..c30; c0 is current). screenTrials 10, searchTrials 200,
            // screenKeep 3. tripling: 10 -> 30 -> 90 -> (270 capped, but we stop first).
            //   Rung 0 @10 : k=30, keep max(3, ceil(30/3)=10)=10.  30 evals.
            //   Rung 1 @30 : k=10, keep max(3, ceil(10/3)=4)=4.    10 evals.  (10 survivors > 3, 3·30=90<200)
            //   Rung 2 @90 : k=4,  keep max(3, ceil(4/3)=2)=3.      4 evals.  (3 <= screenKeep => stop)
            //   Confirm @200: 3 survivors.                          3 evals.
            // Plus baseline(1 @200) + finalize(1 @finalTrials). Total = 30+10+4+3 + 2 = 49 evals.
            const world = ladderWorld(30);
            const { optimizer, scorer } = build(world);

            const result = await optimizer.run(TARGET, {
                screenTrials: 10,
                searchTrials: 200,
                screenKeep: 3,
                finalTrials: 500,
                maxPasses: 1,
                significanceZ: 0
            });

            expect(setup(result).get('weapon')).toBe('c30'); // the true optimum survives the ladder
            expect(scorer.trialsSeen.filter(t => t === 10).length).toBe(30); // rung 0
            expect(scorer.trialsSeen.filter(t => t === 30).length).toBe(10); // rung 1
            expect(scorer.trialsSeen.filter(t => t === 90).length).toBe(4); // rung 2
            // Full-trial (200) evals = baseline(1) + 3 confirmed survivors = 4.
            expect(scorer.trialsSeen.filter(t => t === 200).length).toBe(4);
            expect(scorer.evaluations).toBe(49);
            expect(scorer.trialsSeen).toContain(500); // final re-score fidelity
        });

        it('ladderEvalCount mirrors the ladder accounting exactly (keeps estimators in sync)', () => {
            // The 30-candidate run above: 30 + 10 + 4 rung evals + 3 confirms = 47 per-dimension evals
            // (the run's 49 total is 47 + baseline + finalize).
            expect(ladderEvalCount(30, 10, 200, 3)).toBe(30 + 10 + 4 + 3);
            // Single-rung collapse (3·screenTrials >= searchTrials): one rung, then confirm the
            // max(screenKeep, ceil(k/3)) survivors — wider than screenKeep for big k.
            expect(ladderEvalCount(150, 50, 200, 3)).toBe(150 + 50 + 17);
            // Screening inactive: too few candidates, screening off, or screen at/above full fidelity.
            expect(ladderEvalCount(3, 10, 200, 3)).toBe(3);
            expect(ladderEvalCount(30, 0, 200, 3)).toBe(30);
            expect(ladderEvalCount(30, 200, 200, 3)).toBe(30);
            expect(ladderEvalCount(0, 10, 200, 3)).toBe(0);
        });

        it('skips the ladder entirely when candidates <= screenKeep', async () => {
            const world = ladderWorld(3); // 3 non-current candidates, screenKeep 3
            const { optimizer, scorer } = build(world);

            await optimizer.run(TARGET, { screenTrials: 10, searchTrials: 100, screenKeep: 3, maxPasses: 1 });

            expect(scorer.trialsSeen).not.toContain(10); // no rung ran
        });

        it('collapses to a single screen rung when 3·screenTrials >= searchTrials (old screen->confirm)', async () => {
            // screenTrials 40, searchTrials 100: 3·40=120 >= 100, so the ladder is one rung then confirm,
            // matching the pre-A4 screen->confirm counts. 5 non-current candidates, screenKeep 2.
            const world = ladderWorld(5);
            const { optimizer, scorer } = build(world);

            await optimizer.run(TARGET, {
                screenTrials: 40,
                searchTrials: 100,
                screenKeep: 2,
                finalTrials: 300,
                maxPasses: 1,
                significanceZ: 0
            });

            // One rung @40 over all 5 candidates, then confirm the top 2 @100.
            expect(scorer.trialsSeen.filter(t => t === 40).length).toBe(5);
            // Full-trial (100): baseline(1) + 2 confirmed = 3 — same as the legacy screen->confirm.
            expect(scorer.trialsSeen.filter(t => t === 100).length).toBe(3);
            expect(scorer.trialsSeen).not.toContain(120); // never simulated a rung past searchTrials
        });
    });

    describe('parallel candidate evaluation (evaluateBatch)', () => {
        function buildBatch(world: FakeWorld, scorer = new FakeBatchScorer(world)) {
            const applier = new FakeApplier(world);
            const optimizer = new CoordinateAscentOptimizer(
                scorer,
                equipmentDimensions(applier, new FakeCandidateProvider(world)),
                applier
            );
            return { optimizer, scorer };
        }

        it('finds the same optimum as the serial path and actually uses the batch dispatch', async () => {
            const items = [
                { id: 'w1', slotId: 'weapon', power: 10 },
                { id: 'w2', slotId: 'weapon', power: 20 },
                { id: 'w3', slotId: 'weapon', power: 15 },
                { id: 'b1', slotId: 'body', power: 5 },
                { id: 'b2', slotId: 'body', power: 8 }
            ];
            const start = { weapon: 'w1', body: 'b1' };

            const serial = await build(new FakeWorld(['weapon', 'body'], items, start)).optimizer.run(TARGET);
            const { optimizer, scorer } = buildBatch(new FakeWorld(['weapon', 'body'], items, start));
            const parallel = await optimizer.run(TARGET);

            // Same winner as serial coordinate ascent.
            expect(setup(parallel).get('weapon')).toBe('w2');
            expect(setup(parallel).get('body')).toBe('b2');
            expect(parallel.bestMetric).toBe(serial.bestMetric);
            // The parallel path was exercised — a batch was dispatched with more than one setup (the
            // weapon slot has 2 non-incumbent candidates). Single-candidate slots still fall back to
            // the serial evaluate(), and the baseline + final re-score always use it.
            expect(scorer.batchCalls).toBeGreaterThan(0);
            expect(scorer.maxBatchSize).toBeGreaterThan(1);
        });

        it('respects the death-rate constraint under batched evaluation', async () => {
            const { optimizer } = buildBatch(
                new FakeWorld(
                    ['weapon'],
                    [
                        { id: 'safe', slotId: 'weapon', power: 10, risk: 0 },
                        { id: 'strongA', slotId: 'weapon', power: 90, risk: 0.5 },
                        { id: 'strongB', slotId: 'weapon', power: 100, risk: 0.5 }
                    ],
                    { weapon: 'safe' }
                )
            );

            const result = await optimizer.run(TARGET);

            expect(setup(result).get('weapon')).toBe('safe'); // both strong options die -> rejected
            expect(result.bestDeathRate).toBe(0);
        });

        it('screens and confirms through the batch path, keeping the true optimum', async () => {
            const { optimizer, scorer } = buildBatch(
                new FakeWorld(
                    ['weapon'],
                    [
                        { id: 'w1', slotId: 'weapon', power: 1 },
                        { id: 'w2', slotId: 'weapon', power: 2 },
                        { id: 'w3', slotId: 'weapon', power: 3 },
                        { id: 'w4', slotId: 'weapon', power: 9 }, // winner
                        { id: 'w5', slotId: 'weapon', power: 4 }
                    ],
                    { weapon: 'w1' }
                )
            );

            const result = await optimizer.run(TARGET, {
                searchTrials: 100,
                screenTrials: 10,
                screenKeep: 2,
                finalTrials: 500,
                maxPasses: 1
            });

            expect(setup(result).get('weapon')).toBe('w4');
            // A screen batch (4 candidates) and a confirm batch (2 survivors) both dispatched.
            expect(scorer.batchCalls).toBe(2);
            expect(scorer.maxBatchSize).toBe(4);
        });
    });
});
