/**
 * PURE enumeration of the candidate set for a *compound* Summoning dimension.
 *
 * WHY a compound dimension at all: the optimizer is generic coordinate ascent that changes ONE
 * dimension (one equipment slot) at a time. Summoning familiars can declare a `SummoningSynergy`
 * — a bonus that only applies when a SPECIFIC PAIR is equipped together. Searched independently,
 * each familiar of a synergy pair usually scores WORSE than the incumbent (its solo stats are
 * weak; the payoff lives in the pair), so neither is ever adopted and the synergy is invisible to
 * the search. Controlling BOTH summon slots as one dimension — whose candidate list explicitly
 * contains the declared pairs — lets a single coordinate move adopt a pair atomically.
 *
 * This module is intentionally PURE: it knows nothing about `Global.*`, the game, or
 * `melvor-types`. It takes an abstract list of declared pairs and the set of available summon
 * item ids, and returns the de-duplicated candidate list. That keeps it fully unit-testable; the
 * game-coupled wiring (reading `Global.game.summoning.synergies`, equipping tablets) lives in
 * `adapters.ts`.
 */

/**
 * A choice for the compound summon dimension: which tablet(s) occupy the two summon slots.
 *
 * The two summon slots are interchangeable for the purpose of a synergy (a synergy between A and B
 * fires whether A is in Summon1 and B in Summon2 or vice-versa), so a choice is an UNORDERED pair.
 * We normalize to a canonical order (sorted by id) so two choices that differ only in slot order
 * compare equal and de-duplicate. `first`/`second` are both optional:
 *   - both set   => a pair (one familiar per slot),
 *   - only first => a single familiar (one slot filled),
 *   - neither    => no familiars equipped.
 */
export interface SummonChoice {
    readonly first?: string;
    readonly second?: string;
}

/**
 * Canonicalize a choice so slot order never matters: drop empties, sort the remaining ids, and put
 * the (single) survivor in `first` when only one is present. The result is the unique
 * representative of the unordered set `{first, second}` minus blanks, which makes {@link summonChoicesEqual}
 * and de-duplication trivial string comparisons.
 */
export function normalizeSummonChoice(choice: SummonChoice): SummonChoice {
    const ids = [choice.first, choice.second].filter((id): id is string => id != null && id !== '');
    ids.sort();
    if (ids.length === 0) {
        return {};
    }
    if (ids.length === 1) {
        return { first: ids[0] };
    }
    return { first: ids[0], second: ids[1] };
}

/** A stable string key for a normalized choice — used for de-duplication and equality. */
function choiceKey(choice: SummonChoice): string {
    const n = normalizeSummonChoice(choice);
    return `${n.first ?? ''}|${n.second ?? ''}`;
}

/** Order-insensitive value-equality of two summon choices. */
export function summonChoicesEqual(a: SummonChoice, b: SummonChoice): boolean {
    return choiceKey(a) === choiceKey(b);
}

/** A declared synergy pair of summon item ids (the two familiars' tablet `product` ids). */
export interface SummonPair {
    readonly a: string;
    readonly b: string;
}

/**
 * Enumerate the candidate set for the compound summon dimension, given the declared synergy
 * `pairs` and the `availableIds` of summon tablets the character may equip.
 *
 * The candidate set is, de-duplicated and order-insensitively:
 *   1. the empty option (no familiars) — always a valid choice and the baseline for "drop both",
 *   2. every single available familiar (one slot filled) — so the search can still pick a lone
 *      familiar when that beats any pair, exactly as the per-slot search would have,
 *   3. every declared pair where BOTH ids are available — the whole reason this dimension exists.
 *
 * A pair is included ONLY when both members are available: a pair with an unowned / unequippable
 * member is not a legal loadout, so offering it would just waste an evaluation (and the apply
 * would silently fail to equip the missing tablet). Singles are derived from `availableIds`, not
 * from the pairs, so non-synergy familiars remain searchable too.
 *
 * @param pairs declared synergy pairs (ABSTRACT — the caller maps game synergies to ids).
 * @param availableIds summon tablet ids the character may equip (owned + requirement-met).
 */
export function enumerateSummonChoices(
    pairs: readonly SummonPair[],
    availableIds: Iterable<string>
): SummonChoice[] {
    const available = new Set(availableIds);
    const byKey = new Map<string, SummonChoice>();

    const add = (choice: SummonChoice) => {
        const normalized = normalizeSummonChoice(choice);
        byKey.set(choiceKey(normalized), normalized);
    };

    // 1. The empty option.
    add({});

    // 2. Every available single familiar.
    for (const id of available) {
        add({ first: id });
    }

    // 3. Every declared pair whose members are both available.
    for (const pair of pairs) {
        if (available.has(pair.a) && available.has(pair.b)) {
            add({ first: pair.a, second: pair.b });
        }
    }

    return [...byKey.values()];
}
