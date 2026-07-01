/**
 * Keep only the first item for each distinct signature, preserving order.
 *
 * Used to drop candidates that are INTERCHANGEABLE for combat — e.g. two foods that heal the same
 * amount and grant no stat bonuses. Simulating both just wastes time and invites the optimizer to
 * "recommend" a swap between identical options. Pure and game-agnostic: the caller supplies a
 * signature that captures exactly the combat-relevant properties (and must give distinct-in-combat
 * items distinct signatures, or a real option would be dropped).
 */
export function dedupeBySignature<T>(items: readonly T[], signature: (item: T) => string): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of items) {
        const sig = signature(item);
        if (!seen.has(sig)) {
            seen.add(sig);
            out.push(item);
        }
    }
    return out;
}
