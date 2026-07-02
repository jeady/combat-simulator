import { describe, expect, it } from 'vitest';
import {
    enumerateSummonChoices,
    normalizeSummonChoice,
    SummonChoice,
    summonChoicesEqual
} from 'src/app/optimizer/synergy';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { Dimension, OptimizeResult } from 'src/app/optimizer/types';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import {
    cancelToken,
    FakeApplier,
    FakeCandidateProvider,
    FakeScorer,
    FakeWorld,
    TARGET
} from 'src/app/optimizer/__tests__/fakes';

/** Sort a candidate list into a stable, comparable shape for assertions. */
function keys(choices: SummonChoice[]): string[] {
    return choices.map(c => `${c.first ?? ''}|${c.second ?? ''}`).sort();
}

describe('enumerateSummonChoices (pure)', () => {
    it('always includes the empty option', () => {
        const choices = enumerateSummonChoices([], []);
        expect(choices).toHaveLength(1);
        expect(choices[0]).toEqual({});
    });

    it('includes every available single familiar plus empty', () => {
        const choices = enumerateSummonChoices([], ['a', 'b']);
        expect(keys(choices)).toEqual(['|', 'a|', 'b|'].sort());
    });

    it('includes a declared pair only when BOTH members are available', () => {
        const pairs = [{ a: 'a', b: 'b' }];
        const choices = enumerateSummonChoices(pairs, ['a', 'b']);
        // empty + single a + single b + pair {a,b}
        expect(keys(choices)).toEqual(['|', 'a|', 'b|', 'a|b'].sort());
    });

    it('excludes a declared pair whose member is unavailable', () => {
        const pairs = [{ a: 'a', b: 'missing' }];
        const choices = enumerateSummonChoices(pairs, ['a']);
        // pair dropped (missing not available); only empty + single a
        expect(keys(choices)).toEqual(['|', 'a|'].sort());
    });

    it('de-duplicates pairs declared in either order', () => {
        const pairs = [
            { a: 'a', b: 'b' },
            { a: 'b', b: 'a' } // same unordered pair
        ];
        const choices = enumerateSummonChoices(pairs, ['a', 'b']);
        expect(keys(choices)).toEqual(['|', 'a|', 'b|', 'a|b'].sort());
    });

    it('does not duplicate a single that also appears in a pair', () => {
        const pairs = [{ a: 'a', b: 'b' }];
        const choices = enumerateSummonChoices(pairs, ['a', 'b', 'c']);
        expect(keys(choices)).toEqual(['|', 'a|', 'b|', 'c|', 'a|b'].sort());
    });

    it('omits singles when includeSingles is false (pairs-only, alongside the per-slot dims)', () => {
        const pairs = [{ a: 'a', b: 'b' }];
        // 'c' is available but has no declared pair, so it appears nowhere (the per-slot dims cover it).
        const choices = enumerateSummonChoices(pairs, ['a', 'b', 'c'], false);
        expect(keys(choices)).toEqual(['|', 'a|b'].sort());
    });

    it('pairs-only still keeps only pairs whose members are both available', () => {
        const pairs = [
            { a: 'a', b: 'b' },
            { a: 'a', b: 'missing' }
        ];
        const choices = enumerateSummonChoices(pairs, ['a', 'b'], false);
        expect(keys(choices)).toEqual(['|', 'a|b'].sort());
    });
});

describe('normalizeSummonChoice / summonChoicesEqual', () => {
    it('is order-insensitive', () => {
        expect(summonChoicesEqual({ first: 'a', second: 'b' }, { first: 'b', second: 'a' })).toBe(true);
    });

    it('normalizes order to a canonical (sorted) form', () => {
        expect(normalizeSummonChoice({ first: 'b', second: 'a' })).toEqual({ first: 'a', second: 'b' });
    });

    it('collapses an empty/blank slot to a single', () => {
        expect(normalizeSummonChoice({ first: '', second: 'a' })).toEqual({ first: 'a' });
        expect(normalizeSummonChoice({ second: 'a' })).toEqual({ first: 'a' });
    });

    it('treats no familiars as equal regardless of blanks', () => {
        expect(summonChoicesEqual({}, { first: '' })).toBe(true);
        expect(summonChoicesEqual({ first: 'a' }, { first: 'a', second: '' })).toBe(true);
    });

    it('distinguishes a single from a pair', () => {
        expect(summonChoicesEqual({ first: 'a' }, { first: 'a', second: 'b' })).toBe(false);
    });
});

/**
 * Integration: a world with two summon slots where each familiar alone is weak, but a specific PAIR
 * has a large combined payoff. A per-slot search never adopts either half (each alone scores below
 * the incumbent), but a compound dimension built from the pure enumerator adopts the pair atomically.
 */
describe('compound summon dimension drives coordinate ascent to a synergy pair', () => {
    const SUMMON_1 = 'Summon1';
    const SUMMON_2 = 'Summon2';

    // Model the pair payoff: each familiar has tiny solo power, but the scorer adds a big bonus
    // when BOTH synergy members are equipped together. The optimizer should prefer the pair over
    // any strong single non-synergy familiar.
    function buildWorld() {
        return new FakeWorld(
            [SUMMON_1, SUMMON_2, 'other'],
            [
                // Synergy pair: weak alone (power 1 each) but huge together (bonus added by scorer).
                { id: 'famA', slotId: SUMMON_1, power: 1 },
                { id: 'famB', slotId: SUMMON_2, power: 1 },
                // A strong single familiar with no synergy — beats either synergy half alone.
                { id: 'solo', slotId: SUMMON_1, power: 30 }
            ],
            {}
        );
    }

    /** Build a compound summon dimension over the fake world using the real pure enumerator. */
    function compoundSummonDimension(world: FakeWorld, applier: FakeApplier): Dimension {
        const pairs = [{ a: 'famA', b: 'famB' }];
        const available = new Set(['famA', 'famB', 'solo']);
        return {
            id: 'summon-pair',
            label: 'Summoning',
            getCandidates: () => enumerateSummonChoices(pairs, available),
            getCurrentChoice: () => {
                const loadout = applier.getCurrentLoadout();
                return normalizeSummonChoice({ first: loadout.get(SUMMON_1), second: loadout.get(SUMMON_2) });
            },
            applyChoice: (choice: unknown) => {
                const n = normalizeSummonChoice(choice as SummonChoice);
                world.current.delete(SUMMON_1);
                world.current.delete(SUMMON_2);
                // Place each id into whichever summon slot it belongs to (solo lives in Summon1).
                for (const id of [n.first, n.second].filter((x): x is string => !!x)) {
                    const slot = id === 'famB' ? SUMMON_2 : SUMMON_1;
                    applier.equip(slot, id);
                }
            },
            equals: (a: unknown, b: unknown) => summonChoicesEqual(a as SummonChoice, b as SummonChoice),
            describe: (choice: unknown) => JSON.stringify(normalizeSummonChoice(choice as SummonChoice))
        };
    }

    /** Scorer that rewards the famA+famB pair with a large synergy bonus on top of raw power. */
    class SynergyScorer extends FakeScorer {
        constructor(private readonly w: FakeWorld) {
            super(w);
        }
        public async evaluate(target: any, trials: number, ticks: number, deathAbort?: number) {
            const base = await super.evaluate(target, trials, ticks, deathAbort);
            const equipped = new Set(this.w.current.values());
            const bonus = equipped.has('famA') && equipped.has('famB') ? 100 : 0;
            return { ...base, metric: base.metric + bonus };
        }
    }

    const world = buildWorld();

    it('adopts the pair', async () => {
        const applier = new FakeApplier(world);
        const scorer = new SynergyScorer(world);
        const optimizer = new CoordinateAscentOptimizer(
            scorer,
            [compoundSummonDimension(world, applier)],
            applier
        );

        const result: OptimizeResult = await optimizer.run(TARGET, {}, undefined, cancelToken());

        // Pair payoff (1 + 1 + 100 = 102) beats the strong solo familiar (30). The optimizer
        // restores the baseline to the live world on exit, so the winner lives in result.bestSetup.
        const best = result.bestSetup as Map<string, string>;
        expect(result.bestMetric).toBe(102);
        expect(best.get(SUMMON_1)).toBe('famA');
        expect(best.get(SUMMON_2)).toBe('famB');
    });
});

/**
 * Regression guard for the exclude param: building equipment dimensions with the summon slots
 * excluded drops exactly those dimensions and leaves the rest untouched. (The game-coupled
 * buildDimensions flag can't run headless — Global.* — so we assert the underlying mechanism.)
 */
describe('equipmentDimensions excludeSlotIds', () => {
    it('omits excluded slots and keeps the rest, leaving default behaviour unchanged', () => {
        const world = new FakeWorld(['weapon', 'Summon1', 'Summon2'], []);
        const applier = new FakeApplier(world);
        const candidates = new FakeCandidateProvider(world);

        const all = equipmentDimensions(applier, candidates).map(d => d.id);
        expect(all).toEqual(['weapon', 'Summon1', 'Summon2']);

        const filtered = equipmentDimensions(
            applier,
            candidates,
            id => id,
            new Set(['Summon1', 'Summon2'])
        ).map(d => d.id);
        expect(filtered).toEqual(['weapon']);
    });
});
