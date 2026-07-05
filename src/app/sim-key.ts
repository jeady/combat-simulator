/**
 * Result-storage key builder for per-monster {@link SimulationData}, factored out of `Simulation`
 * so the pure keying contract can be unit-tested headlessly (simulation.ts pulls in the whole game).
 *
 * A monster's simulated result is keyed by the *condition it was simmed under*, so mutually
 * exclusive variants never collide on one entry:
 *
 *  - `entityId` present  => the monster was simmed inside a dungeon / stronghold / abyss-depth; the
 *                           entity prefix disambiguates it and such sims are always off-task, so
 *                           `onTask` is ignored here. Key: `${entityId}-${monsterId}`.
 *  - no entityId, onTask => a plain-monster sim run while "On Slayer Task" was applied (or a slayer
 *                           task's per-monster sim). Key: `task@${monsterId}`.
 *  - otherwise           => a plain off-task monster sim. Key: `${monsterId}`.
 *
 * `task@` can never collide with the other forms: real entity IDs are `namespace:Name` and
 * entity-prefixed keys join with `-`, neither of which begins with `task@`.
 */
export function simKey(monsterId: string, entityId?: string, onTask = false): string {
    if (entityId !== undefined) {
        return `${entityId}-${monsterId}`;
    }

    if (onTask) {
        return `task@${monsterId}`;
    }

    return monsterId;
}
