import { describe, expect, it } from 'vitest';
import { simKey } from 'src/app/sim-key';

/**
 * Contract for the per-monster result-storage key (`Simulation.simId` delegates here). The three
 * variants (entity-context, on-task plain, off-task plain) must map to distinct keys so mutually
 * exclusive sims of the same monster never overwrite one another.
 */
describe('simKey', () => {
    it('keys a plain off-task monster by its bare id', () => {
        expect(simKey('melvorD:Cow')).toBe('melvorD:Cow');
        expect(simKey('melvorD:Cow', undefined, false)).toBe('melvorD:Cow');
    });

    it('keys an on-task plain monster with the task@ prefix', () => {
        expect(simKey('melvorD:Cow', undefined, true)).toBe('task@melvorD:Cow');
    });

    it('distinguishes on-task from off-task variants of the same monster', () => {
        expect(simKey('melvorD:Cow', undefined, true)).not.toBe(simKey('melvorD:Cow', undefined, false));
    });

    it('keys an entity-context sim by the entity prefix and ignores onTask', () => {
        expect(simKey('melvorD:Cow', 'melvorD:Dungeon')).toBe('melvorD:Dungeon-melvorD:Cow');
        // Entity-context sims are always off-task, so onTask has no effect on the key.
        expect(simKey('melvorD:Cow', 'melvorD:Dungeon', true)).toBe('melvorD:Dungeon-melvorD:Cow');
        expect(simKey('melvorD:Cow', 'melvorD:Dungeon', true)).toBe(
            simKey('melvorD:Cow', 'melvorD:Dungeon', false)
        );
    });

    it('produces a task@ key that cannot collide with entity-prefixed or bare keys', () => {
        const taskKey = simKey('melvorD:Cow', undefined, true);
        expect(taskKey.startsWith('task@')).toBe(true);
        // Real entity IDs are `namespace:Name` and entity-prefixed keys join with '-'; neither form
        // begins with `task@`, so the on-task variant is guaranteed unique.
        expect(simKey('melvorD:Cow')).not.toBe(taskKey);
        expect(simKey('melvorD:Cow', 'melvorD:Dungeon')).not.toBe(taskKey);
    });
});
