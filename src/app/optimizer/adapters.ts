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
import { pruneDominated, StatVector } from 'src/app/optimizer/prune';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import { Lookup } from 'src/shared/utils/lookup';
import {
    CandidateProvider,
    Dimension,
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

/**
 * The slayer-task id a target refers to, or undefined. A slayer task can arrive in EITHER field
 * depending on how it was selected on the Simulate page: inspecting a task puts its id in `entityId`,
 * but picking it from the "Select Target" dropdown puts it in `monsterId` (with no `entityId`). A
 * slayer-task id is never a monster id, so checking both is unambiguous — and necessary, or the
 * natural dropdown selection silently falls through to the plain-monster path and every sim fails.
 */
export function slayerTaskTargetId(target: OptimizeTarget | undefined): string | undefined {
    if (!target) {
        return undefined;
    }
    if (target.entityId && Lookup.isSlayerTask(target.entityId)) {
        return target.entityId;
    }
    if (target.monsterId && Lookup.isSlayerTask(target.monsterId)) {
        return target.monsterId;
    }
    return undefined;
}

/**
 * A slayer-task category (e.g. an "Auto Slayer" tier) isn't a single simulatable combat area: the
 * Simulate page sims each accessible task monster individually (entityId undefined) and averages
 * them. {@link GameScorer.evaluate} replicates that, so slayer tasks ARE supported — provided the
 * character can reach at least one monster in the task (otherwise there is nothing to score).
 */
export function isSupportedTarget(target: OptimizeTarget | undefined): boolean {
    if (!target) {
        return false;
    }
    const taskId = slayerTaskTargetId(target);
    if (taskId) {
        return Global.simulation.getAccessibleSlayerTaskMonsters(taskId).length > 0;
    }
    return true;
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
    public async evaluate(
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        // A slayer-task target isn't a single simulatable entity: the Simulate page sims each
        // accessible task monster individually (entityId undefined) and averages them. Replicate
        // that here, via the shared averager, so the optimizer scores the task by the same number
        // the chart shows. The task id may arrive via either target field (see slayerTaskTargetId).
        const taskId = slayerTaskTargetId(target);
        if (taskId) {
            return this.evaluateSlayerTask(taskId, trials, ticks, deathAbortThreshold);
        }

        const data = await this.runSim(target.monsterId, target.entityId, trials, ticks, deathAbortThreshold);
        if (!data) {
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        const metric = Global.simulation.getBarValue(true, data);
        return { metric, deathRate: data.deathRate ?? 0, success: !Number.isNaN(metric) };
    }

    /**
     * Score a slayer-task target: sim every accessible task monster individually, then fold the
     * results into one averaged {@link SimulationData} via {@link Simulation.averageMonsterData} —
     * the same math the Simulate chart uses — and read the plotted metric off it. Monsters whose
     * sim failed are kept as `simSuccess:false` entries so the averager skips them.
     */
    private async evaluateSlayerTask(
        taskId: string,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        const monsters = Global.simulation.getAccessibleSlayerTaskMonsters(taskId);
        if (monsters.length === 0) {
            Global.logger.warn('Optimizer slayer-task sim: no reachable monsters', { taskId });
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        const dataByMonster = new Map<string, SimulationData>();
        let anySuccess = false;
        for (const monster of monsters) {
            // entityId undefined => the worker fights the plain monster, exactly as the Simulate queue does.
            const data = await this.runSim(monster.id, undefined, trials, ticks, deathAbortThreshold);
            if (data) {
                anySuccess = true;
            }
            dataByMonster.set(monster.id, data ?? Global.simulation.newSimDataEntry(true));
        }

        if (!anySuccess) {
            Global.logger.warn('Optimizer slayer-task sim: every task monster failed', {
                taskId,
                monsters: monsters.length
            });
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        const averageData = Global.simulation.newSimDataEntry(false);
        Global.simulation.averageMonsterData(
            averageData,
            monsters,
            true,
            taskId,
            monster => dataByMonster.get(monster.id) as SimulationData
        );

        const metric = Global.simulation.getBarValue(true, averageData);
        return { metric, deathRate: averageData.deathRate ?? 0, success: !Number.isNaN(metric) };
    }

    /**
     * Run one real simulation for a single monster and return its data, or `undefined` if the sim
     * threw or didn't succeed. The worker's own failure reason (e.g. "Simulated 0/200 trials" =>
     * not killed within the tick budget, "cannot access area", a realm/entityId mismatch, …) is
     * logged so an "every simulation failed" run is diagnosable instead of opaque.
     */
    private async runSim(
        monsterId: string,
        entityId: string | undefined,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<SimulationData | undefined> {
        const saveString = Global.game.generateSaveStringSimple();

        let response: SimulateResponse;
        try {
            response = await Global.simulation.simulator.simulate({
                saveString,
                monsterId,
                // Must be undefined (not '') for a plain monster — the worker resolves a combat
                // area from a non-undefined entityId and throws on '', failing every sim.
                entityId: entityId as string,
                trials,
                maxTicks: ticks,
                deathAbortThreshold
            });
        } catch (error) {
            Global.logger.warn('Optimizer sim threw', { monsterId, entityId, error });
            return undefined;
        }

        const data = response?.result as SimulationData | undefined;
        if (!data || !data.simSuccess) {
            Global.logger.warn('Optimizer sim failed', {
                monsterId,
                entityId,
                trials,
                ticks,
                reason: data?.reason ?? 'no result returned'
            });
            return undefined;
        }

        // Realmed plot types (XP, etc.) need data.realmId. The worker already sets it from the
        // monster's area realm; derive it the same way if it's ever missing.
        if (data.realmId === undefined) {
            const monster = Global.game.monsters.getObjectByID(monsterId);
            if (monster) {
                data.realmId = Global.game.getMonsterArea(monster).realm.id;
            }
        }

        return data;
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

        const items = Global.game.items.equipment.filter(item => {
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
        });

        // Prune dominated candidates to shrink the search. Items with special effects (modifiers,
        // special attacks, set/combat effects) aren't captured by raw equipmentStats, so we NEVER
        // prune those — only stat-pure items, and only on the full Pareto frontier across ALL their
        // stats (dropped only if another item is >= on every stat and > on at least one), which can
        // never drop a genuinely-better item.
        const special: string[] = [];
        const plain: StatVector[] = [];
        for (const item of items) {
            if (this.hasSpecialEffect(item)) {
                special.push(item.id);
            } else {
                plain.push({ id: item.id, stats: this.statVector(item) });
            }
        }
        const keys = [...new Set(plain.flatMap(p => Object.keys(p.stats)))];
        return [...special, ...pruneDominated(plain, keys).map(v => v.id)];
    }

    /** An item whose value isn't fully captured by raw equipmentStats must not be pruned. */
    private hasSpecialEffect(item: any): boolean {
        const nonEmpty = (v: any) =>
            v != null && (Array.isArray(v) ? v.length > 0 : typeof v === 'object' ? Object.keys(v).length > 0 : !!v);
        return (
            nonEmpty(item.modifiers) ||
            nonEmpty(item.enemyModifiers) ||
            nonEmpty(item.conditionalModifiers) ||
            nonEmpty(item.specialAttacks) ||
            nonEmpty(item.combatEffects)
        );
    }

    /** Fold an item's equipmentStats into a flat {statKey -> value} vector (damage-type aware). */
    private statVector(item: any): Record<string, number> {
        const stats: Record<string, number> = {};
        for (const stat of item.equipmentStats ?? []) {
            const key = stat.damageType ? `${stat.key}:${stat.damageType.id}` : stat.key;
            stats[key] = (stats[key] ?? 0) + stat.value;
        }
        return stats;
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
        // notify:false — the optimizer restores a snapshot before every candidate; the toast would flood.
        SettingsController.import(snap as Settings, { notify: false });
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

/** Humanize a slot id for the UI/diff (strip namespace, replace underscores). */
function slotLabel(slotId: string): string {
    const local = slotId.includes(':') ? slotId.split(':')[1] : slotId;
    return local.replace(/_/g, ' ');
}

/** Owned = ever found, per the live character. */
function isItemOwned(itemId: string): boolean {
    const liveItem = Global.melvor.items.getObjectByID(itemId);
    return liveItem ? Global.melvor.stats.itemFindCount(liveItem) > 0 : false;
}

/**
 * A non-equipment dimension that mutates one `Settings` field and re-applies the whole setup
 * via the verified `SettingsController.import` path (the same path the config UI uses). The
 * optimizer restores the incumbent before each candidate, so this nets out to "incumbent with
 * one field changed".
 */
function settingsDimension(
    id: string,
    label: string,
    get: (settings: Settings) => unknown,
    set: (settings: Settings, value: unknown) => void,
    candidates: () => unknown[],
    describe: (value: unknown) => string
): Dimension {
    return {
        id,
        label,
        getCandidates: candidates,
        getCurrentChoice: () => get(SettingsController.export()),
        applyChoice: (choice: unknown) => {
            // Graceful degradation: a consumable dimension that fails to apply leaves the
            // incumbent intact (the optimizer restored it first), so it just scores as a no-op
            // rather than breaking the whole run. The error is logged, not swallowed silently.
            try {
                const settings = SettingsController.export();
                set(settings, choice);
                SettingsController.import(settings, { notify: false });
            } catch (error) {
                Global.logger.error(`Optimizer dimension '${id}' failed to apply a choice`, error);
            }
        },
        equals: (a: unknown, b: unknown) => a === b,
        describe
    };
}

/** Food dimension: the equipped combat food (owned). Applied via Settings.foodSelected. */
function foodDimension(ownedOnly: boolean): Dimension {
    return settingsDimension(
        'food',
        'Food',
        settings => settings.foodSelected,
        (settings, value) => (settings.foodSelected = value as string),
        () => Global.game.items.food.allObjects.map(item => item.id).filter(id => !ownedOnly || isItemOwned(id)),
        choice => (choice ? Global.game.items.getObjectByID(choice as string)?.name ?? String(choice) : 'no food')
    );
}

/**
 * Build the optimizer's search dimensions for the live game: equipment (each slot) plus the
 * enabled consumable dimensions (food now; potion/prayers follow). The same `applier` is passed
 * to the optimizer as its SetupApplier. NOTE: consumable dimensions are type-checked and reuse
 * the verified import path, but warrant in-game verification.
 */
export function buildDimensions(
    applier: GameLoadoutApplier,
    candidates: GameCandidateProvider,
    options: { ownedOnly?: boolean; food?: boolean } = {}
): Dimension[] {
    const dims = equipmentDimensions(applier, candidates, slotLabel);
    if (options.food ?? true) {
        dims.push(foodDimension(options.ownedOnly ?? true));
    }
    return dims;
}
