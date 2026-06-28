/**
 * Real, game-backed implementations of the optimizer's injected interfaces. These are the
 * ONLY optimizer modules allowed to touch `Global.*` / the game; the search engine
 * (`optimizer.ts`) depends only on the interfaces in `types.ts`.
 */
import { Global } from 'src/app/global';
import { SettingsController, Settings } from 'src/app/settings-controller';
import { SimulationData } from 'src/app/simulation';
import { PlotKey } from 'src/app/stores/plotter.store';
import { SimulateResponse } from 'src/shared/transport/type/simulate';
import {
    CandidateProvider,
    EquipmentLoadout,
    Evaluation,
    LoadoutApplier,
    OptimizeTarget,
    Scorer,
    SlotRef
} from 'src/app/optimizer/types';

const EMPTY_ITEM = 'melvorD:Empty_Equipment';
const DEBUG_ITEM = 'melvorD:DEBUG_ITEM';

/** Objectives where a smaller value is better. Everything else is maximized. */
const MINIMIZE_KEYS = new Set<PlotKey>([
    PlotKey.DeathRate,
    PlotKey.KillTime,
    PlotKey.FoodUsed,
    PlotKey.AmmoUsed,
    PlotKey.RunesUsed,
    PlotKey.CombinationRunesUsed,
    PlotKey.PotionsUsed,
    PlotKey.ConsumablesUsed,
    PlotKey.TabletsUsed,
    PlotKey.PrayerPointsUsed,
    PlotKey.HighestHitTaken,
    PlotKey.HighestReflectTaken
]);

/**
 * Metrics that come back `NaN` from the worker and are only filled in by `Drops.update()`
 * against the full result set. Not supported as an auto-optimize objective in P1 — the UI
 * should reject them up front. See `docs/auto-optimize.md` §9.4.
 */
export const UNSUPPORTED_KEYS = new Set<PlotKey>([
    PlotKey.GP,
    PlotKey.Drops,
    PlotKey.Signet,
    PlotKey.Pet,
    PlotKey.Mark
]);

export function isSupportedObjective(): boolean {
    return !UNSUPPORTED_KEYS.has(Global.stores.plotter.plotType.key);
}

/** Resolve the target the user currently has selected on the Simulate page. */
export function getSelectedTarget(): OptimizeTarget | undefined {
    const monsterId = Global.stores.plotter.selectedMonsterId;
    if (!monsterId) {
        return undefined;
    }
    const entityId = Global.stores.plotter.state.isInspecting ? Global.stores.plotter.state.inspectedId : undefined;
    return { monsterId, entityId };
}

/**
 * Scores the currently-applied (sim) loadout by running one real simulation and reading the
 * same plotted metric the UI uses (`Simulation.getBarValue`).
 */
export class GameScorer implements Scorer {
    public async evaluate(target: OptimizeTarget, trials: number, ticks: number): Promise<Evaluation> {
        const saveString = Global.game.generateSaveStringSimple();

        let response: SimulateResponse;
        try {
            response = await Global.simulation.simulator.simulate({
                saveString,
                monsterId: target.monsterId,
                entityId: target.entityId ?? '',
                trials,
                maxTicks: ticks
            });
        } catch {
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        const data = response?.result as SimulationData | undefined;
        if (!data || !data.simSuccess) {
            return { metric: NaN, deathRate: data?.deathRate ?? Infinity, success: false };
        }

        // Realmed plot types (XP, etc.) need data.realmId. The worker already sets it from the
        // monster's area realm; derive it the same way if it's ever missing.
        if (data.realmId === undefined) {
            const monster = Global.game.monsters.getObjectByID(target.monsterId);
            if (monster) {
                data.realmId = Global.game.getMonsterArea(monster).realm.id;
            }
        }

        const metric = Global.simulation.getBarValue(true, data);
        return { metric, deathRate: data.deathRate ?? 0, success: !Number.isNaN(metric) };
    }

    public isMaximize(): boolean {
        return !MINIMIZE_KEYS.has(Global.stores.plotter.plotType.key);
    }
}

/** Owned + valid-for-slot + currently-equippable candidate items for a slot. */
export class GameCandidateProvider implements CandidateProvider {
    constructor(private readonly ownedOnly = true) {}

    public getCandidates(slotId: string): string[] {
        const slot = Global.game.equipmentSlots.getObjectByID(slotId);
        if (!slot) {
            return [];
        }

        return Global.game.items.equipment
            .filter(item => {
                if (item.id === EMPTY_ITEM || item.id === DEBUG_ITEM || item.golbinRaidExclusive) {
                    return false;
                }
                if (!item.validSlots.some(valid => valid.id === slotId)) {
                    return false;
                }
                // Requirements (level/skill/etc.). Modded items skip the check, mirroring equipItem.
                if (!item.isModded && !Global.game.checkRequirements(item.equipRequirements, false)) {
                    return false;
                }
                if (this.ownedOnly && !this.isOwned(item.id)) {
                    return false;
                }
                return true;
            })
            .map(item => item.id);
    }

    /** Owned = ever found, per the live character (items are distinct instances across the two games). */
    private isOwned(itemId: string): boolean {
        const liveItem = Global.melvor.items.getObjectByID(itemId);
        return liveItem ? Global.melvor.stats.itemFindCount(liveItem) > 0 : false;
    }
}

/** Mutates / snapshots the sim player's equipment via the existing game + Settings APIs. */
export class GameLoadoutApplier implements LoadoutApplier {
    /** Full, restorable snapshot of the user's configuration. */
    public snapshot(): unknown {
        return SettingsController.export();
    }

    public restore(snap: unknown): void {
        SettingsController.import(snap as Settings);
    }

    public slots(): SlotRef[] {
        return Global.game.equipmentSlots.allObjects.map(slot => ({ id: slot.id }));
    }

    public getCurrentLoadout(): EquipmentLoadout {
        const loadout: EquipmentLoadout = new Map();
        const equipment = Global.game.combat.player.equipment;
        for (const slot of Global.game.equipmentSlots.allObjects) {
            const item = equipment.equippedItems[slot.id]?.item;
            if (item && item.id !== EMPTY_ITEM) {
                loadout.set(slot.id, item.id);
            }
        }
        return loadout;
    }

    public applyLoadout(loadout: EquipmentLoadout): void {
        Global.game.combat.player.equipment.unequipAll();
        for (const [slotId, itemId] of loadout) {
            this.equipInternal(slotId, itemId);
        }
    }

    public equip(slotId: string, itemId: string): void {
        this.equipInternal(slotId, itemId);
    }

    private equipInternal(slotId: string, itemId: string): void {
        const item = Global.game.items.equipment.getObjectByID(itemId);
        const slot = Global.game.equipmentSlots.getObjectByID(slotId);
        if (!item || !slot) {
            return;
        }
        // Skip slots an item only secondarily occupies (e.g. a 2H weapon's shield slot); equip
        // only on its primary slot — mirrors EquipmentPage._import. isImporting=true skips the
        // (unneeded) live stat recompute; the worker recomputes stats from the save string.
        if (item.occupiesSlots.some(occupied => occupied === slot)) {
            return;
        }
        Global.game.combat.player.equipItem(item, 0, slot, 1, true);
    }
}
