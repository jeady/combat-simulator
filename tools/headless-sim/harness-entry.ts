/**
 * Headless harness entry — bundled by esbuild as a classic IIFE and evaluated in the SAME
 * scope as the (already-loaded) game scripts, so `SimGame extends Game` resolves Game from
 * the shared scope. It reuses the real worker boot (WorkerMock + Environment.init) and the
 * real Simulator, and drives the real optimizer against them — all without a browser.
 */
import { Global as GlobalManager } from 'src/shared/global';
import { Global } from 'src/worker/global';
import { WorkerMock } from 'src/worker/context/mock';
import { Environment } from 'src/worker/context/environment';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import { MemoizingScorer } from 'src/app/optimizer/cache';
import {
    CandidateProvider,
    EquipmentLoadout,
    Evaluation,
    LoadoutApplier,
    OptimizeTarget,
    Scorer,
    SlotRef
} from 'src/app/optimizer/types';

/** Stable key for a loadout map (sorted slot=item pairs) — the cache's setup identity. */
function loadoutKey(loadout: EquipmentLoadout): string {
    return [...loadout.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([s, i]) => `${s}=${i}`).join(',');
}

const EMPTY = 'melvorD:Empty_Equipment';
const g = () => (Global as any).game;

/** Scores the currently-applied loadout by running one real simulation (objective: XP/hr). */
class HarnessScorer implements Scorer {
    public async evaluate(target: OptimizeTarget, trials: number, ticks: number): Promise<Evaluation> {
        const saveString = g().generateSaveStringSimple();
        const res: any = await (Global as any).simulator.simulateMonster(
            saveString,
            target.monsterId,
            target.entityId,
            trials,
            ticks
        );
        if (!res || !res.simSuccess || Number.isNaN(res.xpPerSecondMelvor)) {
            return { metric: NaN, deathRate: res?.deathRate ?? Infinity, success: false };
        }
        return { metric: res.xpPerSecondMelvor, deathRate: res.deathRate ?? 0, success: true };
    }
    public isMaximize() {
        return true;
    }
}

/** Mutates / snapshots the sim player's equipment (mirrors the app's GameLoadoutApplier). */
class HarnessApplier implements LoadoutApplier {
    public snapshot(): unknown {
        return this.getCurrentLoadout();
    }
    public restore(snap: unknown): void {
        this.applyLoadout(snap as EquipmentLoadout);
    }
    public slots(): SlotRef[] {
        return g().equipmentSlots.allObjects.map((s: any) => ({ id: s.id }));
    }
    public getCurrentLoadout(): EquipmentLoadout {
        const loadout: EquipmentLoadout = new Map();
        const equipment = g().combat.player.equipment;
        for (const slot of g().equipmentSlots.allObjects) {
            const item = equipment.equippedItems[slot.id]?.item;
            if (item && item.id !== EMPTY) {
                loadout.set(slot.id, item.id);
            }
        }
        return loadout;
    }
    public applyLoadout(loadout: EquipmentLoadout): void {
        g().combat.player.equipment.unequipAll();
        for (const [slotId, itemId] of loadout) {
            this.equip(slotId, itemId);
        }
    }
    public equip(slotId: string, itemId: string): void {
        const item = g().items.equipment.getObjectByID(itemId);
        const slot = g().equipmentSlots.getObjectByID(slotId);
        if (!item || !slot || item.occupiesSlots.some((occupied: any) => occupied === slot)) {
            return;
        }
        g().combat.player.equipItem(item, 0, slot, 1, true);
    }
    public unequip(slotId: string): void {
        const slot = g().equipmentSlots.getObjectByID(slotId);
        if (slot) {
            g().combat.player.unequipItem(0, slot);
        }
    }
}

/** Per-slot candidate item ids, supplied by the harness test. */
class HarnessCandidateProvider implements CandidateProvider {
    constructor(private readonly bySlot: Record<string, string[]>) {}
    public getCandidates(slotId: string): string[] {
        return this.bySlot[slotId] ?? [];
    }
}

(globalThis as any).__harness = {
    get global() {
        return Global;
    },
    async init(data: any) {
        GlobalManager.setWorker(Global);
        WorkerMock.init();
        await Environment.init(data);
        return true;
    },
    simulate(
        saveString: string,
        monsterId: string,
        entityId: string | undefined,
        trials: number,
        maxTicks: number,
        deathAbortThreshold?: number
    ) {
        return (Global as any).simulator.simulateMonster(
            saveString,
            monsterId,
            entityId,
            trials,
            maxTicks,
            deathAbortThreshold
        );
    },
    /** Run the real CoordinateAscentOptimizer against the live SimGame, headless. */
    async optimize(target: OptimizeTarget, candidatesBySlot: Record<string, string[]>, options: any) {
        const applier = new HarnessApplier();
        // Wrap the real scorer in the memoization cache (unless the test disables it). The key reads
        // the loadout currently applied to the player, so repeated setups (convergence passes,
        // restarts) are served without re-simulating. Exposed via __harness.cacheStats below.
        const base: Scorer = new HarnessScorer();
        const scorer = options?.useCache === false ? base : new MemoizingScorer(base, () => loadoutKey(applier.getCurrentLoadout()));
        const optimizer = new CoordinateAscentOptimizer(
            scorer,
            equipmentDimensions(applier, new HarnessCandidateProvider(candidatesBySlot)),
            applier
        );
        const result = await optimizer.run(target, options);
        (globalThis as any).__harness.cacheStats =
            scorer instanceof MemoizingScorer
                ? { hits: scorer.hits, misses: scorer.misses, size: scorer.size }
                : null;
        return result;
    }
};
