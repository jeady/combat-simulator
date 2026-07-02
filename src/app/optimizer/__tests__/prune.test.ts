import { describe, expect, it } from 'vitest';
import {
    directStatsForDominance,
    irrelevantOffensiveKeys,
    pruneDominated,
    relevantStatKeysForStyle,
    statSignature,
    stripStatKeys,
    StatVector
} from 'src/app/optimizer/prune';
import { dedupeBySignature } from 'src/app/optimizer/dedupe';

const KEYS = ['attack', 'strength', 'defence'];

function ids(items: StatVector[]): string[] {
    return items.map(item => item.id).sort();
}

describe('pruneDominated', () => {
    it('removes a strictly dominated item', () => {
        const better: StatVector = { id: 'better', stats: { attack: 10, strength: 10, defence: 10 } };
        const worse: StatVector = { id: 'worse', stats: { attack: 5, strength: 5, defence: 5 } };

        const result = pruneDominated([better, worse], KEYS);

        expect(ids(result)).toEqual(['better']);
    });

    it('always keeps the best item', () => {
        const best: StatVector = { id: 'best', stats: { attack: 20, strength: 20, defence: 20 } };
        const items = [
            best,
            { id: 'mid', stats: { attack: 10, strength: 10, defence: 10 } },
            { id: 'low', stats: { attack: 1, strength: 1, defence: 1 } }
        ];

        const result = pruneDominated(items, KEYS);

        expect(ids(result)).toEqual(['best']);
    });

    it('keeps both items when their vectors are equal (neither strictly dominates)', () => {
        const a: StatVector = { id: 'a', stats: { attack: 7, strength: 7, defence: 7 } };
        const b: StatVector = { id: 'b', stats: { attack: 7, strength: 7, defence: 7 } };

        const result = pruneDominated([a, b], KEYS);

        expect(ids(result)).toEqual(['a', 'b']);
    });

    it('keeps trade-off items on the Pareto frontier (better in one stat, worse in another)', () => {
        const attacker: StatVector = { id: 'attacker', stats: { attack: 10, strength: 2, defence: 0 } };
        const defender: StatVector = { id: 'defender', stats: { attack: 2, strength: 10, defence: 0 } };

        const result = pruneDominated([attacker, defender], KEYS);

        expect(ids(result)).toEqual(['attacker', 'defender']);
    });

    it('treats missing stat keys as 0', () => {
        // `full` has every key; `partial` omits defence, which defaults to 0 — but is otherwise
        // strictly better on attack, so it is NOT dominated and must be kept.
        const full: StatVector = { id: 'full', stats: { attack: 5, strength: 5, defence: 5 } };
        const partial: StatVector = { id: 'partial', stats: { attack: 9, strength: 5 } };

        const result = pruneDominated([full, partial], KEYS);

        expect(ids(result)).toEqual(['full', 'partial']);
    });

    it('drops an item that is dominated once a missing key defaults to 0', () => {
        const full: StatVector = { id: 'full', stats: { attack: 5, strength: 5, defence: 5 } };
        // `partial` ties on attack/strength and has defence default to 0 < 5 -> strictly dominated.
        const partial: StatVector = { id: 'partial', stats: { attack: 5, strength: 5 } };

        const result = pruneDominated([full, partial], KEYS);

        expect(ids(result)).toEqual(['full']);
    });

    it('returns empty output for empty input', () => {
        expect(pruneDominated([], KEYS)).toEqual([]);
    });

    it('keeps everything when there are no relevant keys to compare on', () => {
        const items = [
            { id: 'a', stats: { attack: 1 } },
            { id: 'b', stats: { attack: 9 } }
        ];

        expect(ids(pruneDominated(items, []))).toEqual(['a', 'b']);
    });
});

describe('directStatsForDominance (lower-is-better axis flip)', () => {
    // Regression: attackSpeed is the attack INTERVAL (ms) — higher = slower = worse — but pruneDominated
    // assumes higher-is-better on every axis. Without this flip a stat-pure SLOW weapon that ties/beats a
    // FAST weapon on every bonus but has a larger attackSpeed wrongly "dominated" it, discarding the
    // faster (possibly optimal-DPS) weapon before any sim ran. Negating attackSpeed makes the faster
    // weapon the dominant one, the correct direction.
    it('negates attackSpeed and leaves other stats untouched', () => {
        expect(directStatsForDominance({ attackSpeed: 2400, strength: 10 })).toEqual({
            attackSpeed: -2400,
            strength: 10
        });
    });

    it('negates a damage-type-suffixed attackSpeed key by its base key', () => {
        expect(directStatsForDominance({ 'attackSpeed:melvorD:Normal': 3000, strength: 5 })).toEqual({
            'attackSpeed:melvorD:Normal': -3000,
            strength: 5
        });
    });

    it('keeps a fast-weak and a slow-strong weapon BOTH on the frontier after the direction fix', () => {
        // A fast, low-strength weapon vs a slow, high-strength one: a genuine trade-off, so both survive.
        const fast: StatVector = { id: 'fast', stats: { attackSpeed: 2200, strength: 10 } };
        const slowStrong: StatVector = { id: 'slowStrong', stats: { attackSpeed: 3200, strength: 50 } };

        const directional = [fast, slowStrong].map(w => ({ id: w.id, stats: directStatsForDominance(w.stats) }));
        const keys = [...new Set(directional.flatMap(w => Object.keys(w.stats)))];

        expect(ids(pruneDominated(directional, keys))).toEqual(['fast', 'slowStrong']);
    });

    it('prunes an item that is strictly worse INCLUDING slower', () => {
        // `good` is faster (lower attackSpeed) and stronger — it strictly dominates `bad` on both axes.
        const good: StatVector = { id: 'good', stats: { attackSpeed: 2200, strength: 50 } };
        const bad: StatVector = { id: 'bad', stats: { attackSpeed: 3200, strength: 10 } };

        const directional = [good, bad].map(w => ({ id: w.id, stats: directStatsForDominance(w.stats) }));
        const keys = [...new Set(directional.flatMap(w => Object.keys(w.stats)))];

        expect(ids(pruneDominated(directional, keys))).toEqual(['good']);
    });
});

describe('irrelevantOffensiveKeys / stripStatKeys (style-dead stat pruning)', () => {
    it('marks exactly the OTHER styles\' offensive keys as dead', () => {
        const melee = irrelevantOffensiveKeys('melee');
        expect(melee.has('rangedAttackBonus')).toBe(true);
        expect(melee.has('rangedStrengthBonus')).toBe(true);
        expect(melee.has('magicAttackBonus')).toBe(true);
        expect(melee.has('magicDamageBonus')).toBe(true);
        // Own-style offence and style-agnostic keys are never dead.
        expect(melee.has('meleeStrengthBonus')).toBe(false);
        expect(melee.has('attackSpeed')).toBe(false);
        expect(melee.has('resistance')).toBe(false);
    });

    it('strips dead base keys including damage-type-suffixed variants, leaving the rest', () => {
        const stripped = stripStatKeys(
            { stabAttackBonus: 5, rangedAttackBonus: 50, 'rangedStrengthBonus:melvorItA:Abyssal': 12, attackSpeed: 2400 },
            irrelevantOffensiveKeys('melee')
        );
        expect(stripped).toEqual({ stabAttackBonus: 5, attackSpeed: 2400 });
    });

    it('an item whose only edge is a dead-style bonus becomes dominated after stripping', () => {
        const meleeHelm: StatVector = { id: 'meleeHelm', stats: { stabAttackBonus: 5 } };
        const hybridHelm: StatVector = { id: 'hybridHelm', stats: { stabAttackBonus: 3, rangedAttackBonus: 50 } };

        const dead = irrelevantOffensiveKeys('melee');
        const stripped = [meleeHelm, hybridHelm].map(v => ({ id: v.id, stats: stripStatKeys(v.stats, dead) }));
        const keys = [...new Set(stripped.flatMap(v => Object.keys(v.stats)))];

        expect(ids(pruneDominated(stripped, keys))).toEqual(['meleeHelm']);
        // Unstripped, the ranged bonus is a (dead) trade-off axis that wrongly keeps both alive.
        const rawKeys = [...new Set([meleeHelm, hybridHelm].flatMap(v => Object.keys(v.stats)))];
        expect(ids(pruneDominated([meleeHelm, hybridHelm], rawKeys))).toEqual(['hybridHelm', 'meleeHelm']);
    });
});

describe('relevantStatKeysForStyle', () => {
    it('includes style-specific offensive keys', () => {
        expect(relevantStatKeysForStyle('melee')).toContain('meleeStrengthBonus');
        expect(relevantStatKeysForStyle('ranged')).toContain('rangedStrengthBonus');
        expect(relevantStatKeysForStyle('magic')).toContain('magicDamageBonus');
    });

    it('does not leak another style\'s offensive keys', () => {
        const melee = relevantStatKeysForStyle('melee');
        expect(melee).not.toContain('rangedStrengthBonus');
        expect(melee).not.toContain('magicDamageBonus');
    });

    it('shares defensive keys across styles', () => {
        for (const style of ['melee', 'ranged', 'magic'] as const) {
            expect(relevantStatKeysForStyle(style)).toContain('resistance');
        }
    });
});

describe('statSignature (stat-identical de-duplication)', () => {
    it('is equal for identical vectors and insensitive to key order / explicit zeros', () => {
        expect(statSignature({ attack: 5, strength: 3 })).toBe(statSignature({ strength: 3, attack: 5 }));
        // An explicit 0 is the same as an absent key (Melvor's default), so these collide.
        expect(statSignature({ attack: 5, defence: 0 })).toBe(statSignature({ attack: 5 }));
    });

    it('differs when any stat differs', () => {
        expect(statSignature({ attack: 5 })).not.toBe(statSignature({ attack: 6 }));
        expect(statSignature({ attack: 5 })).not.toBe(statSignature({ attack: 5, strength: 1 }));
    });

    it('folds every no-combat-stat item into one candidate', () => {
        const items: StatVector[] = [
            { id: 'cosmeticA', stats: {} },
            { id: 'cosmeticB', stats: { attack: 0 } }, // explicit zero == no stats
            { id: 'real', stats: { attack: 4 } }
        ];
        const deduped = dedupeBySignature(items, item => statSignature(item.stats));
        // Only the first no-stat item survives, alongside the genuinely-different one.
        expect(ids(deduped)).toEqual(['cosmeticA', 'real']);
    });

    it('collapses combat-identical duplicates before pruning (keeps the first)', () => {
        const items: StatVector[] = [
            { id: 'twinA', stats: { attack: 7, strength: 2 } },
            { id: 'twinB', stats: { strength: 2, attack: 7 } }, // identical -> interchangeable
            { id: 'weaker', stats: { attack: 1 } }
        ];
        const deduped = dedupeBySignature(items, item => statSignature(item.stats));
        const survivors = pruneDominated(deduped, ['attack', 'strength']);
        // One of the twins collapses; the strictly-worse item is then pruned by dominance.
        expect(ids(survivors)).toEqual(['twinA']);
    });
});
