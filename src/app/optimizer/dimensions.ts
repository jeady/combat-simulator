/**
 * Adapts an equipment {@link LoadoutApplier} + {@link CandidateProvider} into per-slot
 * {@link Dimension}s, so the generic coordinate-ascent optimizer can search equipment slots
 * alongside non-equipment dimensions (prayers, potion, food, …) without special-casing them.
 *
 * Pure — no game dependency — so it's reused by both the real adapters and the headless fakes.
 */
import { CandidateProvider, Dimension, LoadoutApplier } from 'src/app/optimizer/types';

/**
 * One Dimension per equipment slot. A choice is an item id (string); empty is `null`.
 *
 * `excludeSlotIds` (default: none) drops the named slots from the result. This exists so a caller
 * that searches certain slots via a *different* dimension can prevent the optimizer from ALSO
 * searching them per-slot — e.g. the compound Summoning dimension owns both summon slots together,
 * and a per-slot summon dimension would fight it (each would clobber the other's pick). The param
 * is optional and defaults to excluding nothing, so existing callers are unaffected.
 */
export function equipmentDimensions(
    applier: LoadoutApplier,
    candidates: CandidateProvider,
    label: (slotId: string) => string = slotId => slotId,
    excludeSlotIds: Set<string> = new Set(),
    includeEmpty = false
): Dimension[] {
    return applier
        .slots()
        .filter(slot => !excludeSlotIds.has(slot.id))
        .map(slot => ({
        id: slot.id,
        label: label(slot.id),
        // With `includeEmpty`, `null` (unequip) is offered as a candidate so the search can leave a
        // slot empty when that's genuinely better (a cursed/negative item, or freeing a coupled slot).
        // Coordinate ascent could previously only SWAP, never empty a slot. Opt-in so existing callers
        // (and their evaluation-count assertions) are unaffected.
        getCandidates: () => (includeEmpty ? [...candidates.getCandidates(slot.id), null] : candidates.getCandidates(slot.id)),
        getCurrentChoice: () => applier.getCurrentLoadout().get(slot.id) ?? null,
        applyChoice: (choice: unknown) => {
            if (choice != null) {
                applier.equip(slot.id, choice as string);
            } else {
                applier.unequip(slot.id);
            }
        },
        equals: (a: unknown, b: unknown) => a === b,
        describe: (choice: unknown) => (choice == null ? 'empty' : String(choice))
    }));
}
