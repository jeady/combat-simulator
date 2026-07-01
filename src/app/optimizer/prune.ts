/**
 * Dominance-based candidate pruning (P2).
 *
 * Before the optimizer spends an expensive simulation on every owned item in a slot, we can
 * cheaply discard items that are *strictly dominated* on the combat stats that matter. An
 * item A dominates an item B when A is at-least-as-good as B on every relevant stat AND
 * strictly better on at least one. A dominated item can never beat its dominator in any
 * loadout (every stat it contributes is matched or exceeded), so it can never be part of an
 * optimal loadout and is safe to drop. What remains is the Pareto frontier — the set of
 * non-dominated items — which shrinks the search space without discarding any potential
 * optimum.
 *
 * This module is intentionally PURE and game-agnostic: it knows nothing about `Global.*` or
 * `melvor-types`, so it can be unit-tested headless. The caller is responsible for mapping
 * real items into {@link StatVector}s and for choosing which stats are "relevant".
 *
 * Note on "relevant" stats: dominance is only sound with respect to the stats that actually
 * influence the objective for the *current attack style*. A melee item's ranged/magic bonuses
 * are dead weight when fighting in melee, so including them would wrongly preserve an item
 * that is strictly worse for melee just because it happens to carry an irrelevant ranged
 * bonus. The integration layer therefore picks the key set per attack style (see
 * {@link relevantStatKeysForStyle}).
 */

/** A minimal, game-agnostic item shape: an id plus a sparse map of stat -> value. */
export interface StatVector {
    id: string;
    stats: Record<string, number>;
}

/** Read a stat, treating an absent key as 0 (the Melvor default for an unset bonus). */
function statValue(item: StatVector, key: string): number {
    const value = item.stats[key];
    return value === undefined ? 0 : value;
}

/**
 * A canonical string for a stat vector, for collapsing combat-identical stat-pure items to one
 * candidate (via {@link dedupeBySignature}). Zero-valued and absent keys are equivalent (Melvor's
 * default is 0), so they're dropped — which means every item with NO combat stats maps to the SAME
 * (empty) signature and folds into a single representative. Keys are sorted so equal vectors always
 * produce byte-identical output. Only sound for items whose value is fully captured by these stats
 * (i.e. NOT items with modifiers/special attacks/effects — the caller must exclude those).
 */
export function statSignature(stats: Record<string, number>): string {
    return Object.entries(stats)
        .filter(([, value]) => value !== 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
}

/**
 * Does `a` strictly dominate `b` over `keys`?
 *
 * True iff `a` is >= `b` on every relevant key AND strictly > on at least one. Equal vectors
 * therefore do NOT dominate each other (no strictly-better key), so ties are preserved by the
 * caller — both items survive.
 */
function dominates(a: StatVector, b: StatVector, keys: string[]): boolean {
    let strictlyBetterSomewhere = false;
    for (const key of keys) {
        const av = statValue(a, key);
        const bv = statValue(b, key);
        if (av < bv) {
            return false;
        }
        if (av > bv) {
            strictlyBetterSomewhere = true;
        }
    }
    return strictlyBetterSomewhere;
}

/**
 * Return the non-dominated (Pareto-frontier) subset of `items` over `relevantKeys`, preserving
 * the input order of the survivors.
 *
 * An item is kept unless some *other* item strictly dominates it. Items with identical stat
 * vectors are all kept (neither strictly dominates the other). Missing stat keys count as 0.
 *
 * Complexity is O(n^2 * k), which is fine for the per-slot item counts the optimizer deals
 * with (tens, occasionally low hundreds).
 */
export function pruneDominated(items: StatVector[], relevantKeys: string[]): StatVector[] {
    // With nothing to compare on, no item can dominate another — everything survives.
    if (relevantKeys.length === 0) {
        return items.slice();
    }

    return items.filter((candidate, i) =>
        !items.some((other, j) => i !== j && dominates(other, candidate, relevantKeys))
    );
}

/**
 * A starting set of `equipmentStats` keys that influence combat for each attack style. The
 * keys mirror Melvor's `EquipmentStats` shape; this is a deliberately conservative starting
 * point meant to be refined as the analytic surrogate scorer (P2) firms up exactly which
 * stats move the chosen objective. Defensive keys are shared across styles (you take damage
 * the same way regardless of how you attack); offensive keys are style-specific.
 *
 * Intentionally style-specific so that, e.g., a melee item is not kept alive merely because it
 * carries an irrelevant ranged bonus.
 */
export function relevantStatKeysForStyle(style: 'melee' | 'ranged' | 'magic'): string[] {
    // Shared defensive stats — meaningful in every style.
    const defensive = [
        'stabDefenceBonus',
        'slashDefenceBonus',
        'blockDefenceBonus',
        'rangedDefenceBonus',
        'magicDefenceBonus',
        'damageReduction',
        'resistance'
    ];

    const offensive: Record<typeof style, string[]> = {
        melee: ['stabAttackBonus', 'slashAttackBonus', 'blockAttackBonus', 'meleeStrengthBonus'],
        ranged: ['rangedAttackBonus', 'rangedStrengthBonus'],
        magic: ['magicAttackBonus', 'magicDamageBonus']
    } as Record<typeof style, string[]>;

    return [...offensive[style], ...defensive];
}
