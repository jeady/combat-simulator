/**
 * Adapts an equipment {@link LoadoutApplier} + {@link CandidateProvider} into per-slot
 * {@link Dimension}s, so the generic coordinate-ascent optimizer can search equipment slots
 * alongside non-equipment dimensions (prayers, potion, food, …) without special-casing them.
 *
 * Pure — no game dependency — so it's reused by both the real adapters and the headless fakes.
 */
import { CandidateProvider, Dimension, LoadoutApplier } from 'src/app/optimizer/types';

/** One Dimension per equipment slot. A choice is an item id (string); empty is `null`. */
export function equipmentDimensions(
    applier: LoadoutApplier,
    candidates: CandidateProvider,
    label: (slotId: string) => string = slotId => slotId
): Dimension[] {
    return applier.slots().map(slot => ({
        id: slot.id,
        label: label(slot.id),
        getCandidates: () => candidates.getCandidates(slot.id),
        getCurrentChoice: () => applier.getCurrentLoadout().get(slot.id) ?? null,
        applyChoice: (choice: unknown) => {
            if (choice != null) {
                applier.equip(slot.id, choice as string);
            }
        },
        equals: (a: unknown, b: unknown) => a === b,
        describe: (choice: unknown) => (choice == null ? 'empty' : String(choice))
    }));
}
