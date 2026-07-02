/**
 * Real, game-backed implementations of the optimizer's injected interfaces. These are the
 * ONLY optimizer modules allowed to touch `Global.*` / the game; the search engine
 * (`optimizer.ts`) depends only on the interfaces in `types.ts`.
 */
import { Global } from 'src/app/global';
import { SettingsController, Settings, AgilitySettings } from 'src/app/settings-controller';
import { SimulationData } from 'src/app/simulation';
import { PlotKey } from 'src/app/stores/plotter.store';
import { ItemPool } from 'src/app/stores/optimizer.store';
import { SimulateRequest, SimulateResponse } from 'src/shared/transport/type/simulate';
import { WorkerPool } from 'src/app/optimizer/worker-pool';
import { directStatsForDominance, pruneDominated, statSignature, StatVector } from 'src/app/optimizer/prune';
import { YIELD_STRIDE, yieldToEventLoop } from 'src/app/optimizer/parallel';
import { equipmentDimensions } from 'src/app/optimizer/dimensions';
import { enumerateSummonChoices, normalizeSummonChoice, SummonChoice, SummonPair, summonChoicesEqual } from 'src/app/optimizer/synergy';
import { PreRankingCandidateProvider } from 'src/app/optimizer/prerank';
import { dedupeBySignature } from 'src/app/optimizer/dedupe';
import {
    ammoUsableWithWeapon,
    AttackTypeConstraint,
    resolveAttackTypeConstraint,
    weaponAllowedByAttackType
} from 'src/app/optimizer/weapon-rules';
import { AnalyticMetric, CombatStats, estimateMetric, TargetStats } from 'src/app/optimizer/analytic-scorer';
import { meanStdError } from 'src/app/optimizer/statistics';
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

/** The weapon and ammo (quiver) equipment slots — coupled: ammo is only useful to a ranged weapon. */
const WEAPON_SLOT = 'melvorD:Weapon';
const QUIVER_SLOT = 'melvorD:Quiver';

/** The two equipment slots that hold summon tablets — searched together by the compound synergy dim. */
const SUMMON_SLOT_1 = 'melvorD:Summon1';
const SUMMON_SLOT_2 = 'melvorD:Summon2';
export const SUMMON_SLOT_IDS = new Set([SUMMON_SLOT_1, SUMMON_SLOT_2]);

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

/** A dungeon / stronghold / abyss-depth id — the aggregate combat areas the Simulate chart averages. */
function isAggregateAreaId(id: string | undefined): boolean {
    return Lookup.isDungeon(id) || Lookup.isStronghold(id) || Lookup.isDepth(id);
}

/**
 * The dungeon/stronghold/abyss-depth id an AGGREGATE target refers to, or undefined. Like a slayer
 * task, the area id can arrive in `monsterId`: selecting the dungeon-level bar on the Simulate page
 * (without inspecting) puts the DUNGEON id into `bars.monsterIds`, so {@link getSelectedTarget}
 * returns `{ monsterId: <dungeonId> }` — an area id is never a monster id, so that's unambiguous.
 * UNLIKE slayerTaskTargetId, an area id in `entityId` does NOT by itself mark an aggregate target:
 * inspecting a dungeon and picking a monster bar yields `{ monsterId: <monster>, entityId:
 * <dungeonId> }`, which is the already-supported single-fight-in-dungeon-context sim and must stay
 * one. Only when `monsterId` doesn't resolve to a real monster does `entityId` decide (defensive —
 * getSelectedTarget shouldn't produce that shape today).
 */
export function dungeonTargetId(target: OptimizeTarget | undefined): string | undefined {
    if (!target) {
        return undefined;
    }
    if (isAggregateAreaId(target.monsterId)) {
        return target.monsterId;
    }
    if (isAggregateAreaId(target.entityId) && !Lookup.monsters.getObjectByID(target.monsterId)) {
        return target.entityId;
    }
    return undefined;
}

/**
 * A slayer-task category (e.g. an "Auto Slayer" tier) isn't a single simulatable combat area: the
 * Simulate page sims each accessible task monster individually (entityId undefined) and averages
 * them. {@link GameScorer.evaluate} replicates that, so slayer tasks ARE supported — provided the
 * character can reach at least one monster in the task (otherwise there is nothing to score).
 * A dungeon/stronghold/abyss-depth aggregate is scored the same way (each monster simmed in the
 * area's context, then averaged), so it's supported whenever the area actually has monsters.
 */
export function isSupportedTarget(target: OptimizeTarget | undefined): boolean {
    if (!target) {
        return false;
    }
    const taskId = slayerTaskTargetId(target);
    if (taskId) {
        return Global.simulation.getAccessibleSlayerTaskMonsters(taskId).length > 0;
    }
    const dungeonId = dungeonTargetId(target);
    if (dungeonId) {
        return Lookup.getMonsterList(dungeonId).length > 0;
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
    /**
     * @param batches split each evaluation's trials into this many independent sub-runs (in ONE
     * worker call) to estimate the metric's standard error for the optimizer's significance gate.
     * The heavy save decode is paid once per evaluation instead of once per sub-run (as the old
     * app-side `BatchingScorer` did). ≤1 disables batching (single run, no stderr).
     * @param minTrialsPerBatch never split so finely that a batch has fewer than this many trials.
     * @param pool when supplied, a pool of N workers used by {@link evaluateBatch} to sim a
     * dimension's candidates concurrently. Without it the scorer exposes no batch method and the
     * optimizer evaluates candidates one at a time through the single shared worker (unchanged).
     */
    constructor(
        private readonly batches = 5,
        private readonly minTrialsPerBatch = 5,
        private readonly pool?: WorkerPool
    ) {
        // Only advertise the parallel path when there's a pool to run it on — the optimizer keys off
        // the method's presence, so a pool-less GameScorer stays on the verified serial path.
        if (pool) {
            this.evaluateBatch = this.runBatch.bind(this);
        }
    }

    /** Present only when constructed with a worker pool (see {@link runBatch}). */
    public evaluateBatch?: (
        setups: unknown[],
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ) => Promise<Evaluation[]>;

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

        // Likewise a dungeon/stronghold/abyss-depth aggregate: sim each of the area's monsters in
        // the area's context and average them, the same math behind the chart's dungeon-level bar.
        const dungeonId = dungeonTargetId(target);
        if (dungeonId) {
            return this.evaluateDungeon(dungeonId, trials, ticks, deathAbortThreshold);
        }

        const batches = this.resolveBatches(trials);
        const datas = await this.runSim(target.monsterId, target.entityId, trials, ticks, deathAbortThreshold, batches);
        if (!datas) {
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        return this.foldBatches(datas);
    }

    /** How many batches actually fit: need ≥2 for a standard error, each ≥ minTrialsPerBatch. */
    private resolveBatches(trials: number): number {
        if (this.batches <= 1) {
            return 1;
        }
        const b = Math.min(this.batches, Math.floor(trials / this.minTrialsPerBatch));
        return b >= 2 ? b : 1;
    }

    /**
     * Fold per-batch sim results into one {@link Evaluation}: the metric is the mean of the per-batch
     * plotted values, with the batch-means standard error (undefined for a single batch). The death
     * rate is the mean of the per-batch rates (equal-size batches ⇒ the pooled rate).
     */
    private foldBatches(datas: SimulationData[]): Evaluation {
        const metrics = datas.map(data => Global.simulation.getBarValue(true, data)).filter(m => Number.isFinite(m));
        if (metrics.length === 0) {
            return { metric: NaN, deathRate: Infinity, success: false };
        }
        const deathRate = datas.reduce((sum, data) => sum + (data.deathRate ?? 0), 0) / datas.length;
        if (metrics.length < 2) {
            return { metric: metrics[0], deathRate, success: true };
        }
        const { mean, stdError } = meanStdError(metrics);
        return { metric: mean, deathRate, success: true, stdError: Number.isFinite(stdError) ? stdError : undefined };
    }

    /**
     * Score a slayer-task target: sim every accessible task monster individually (entityId
     * undefined => the worker fights the plain monster, exactly as the Simulate queue does), then
     * average — see {@link evaluateAggregate}.
     */
    private async evaluateSlayerTask(
        taskId: string,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        const monsters = Global.simulation.getAccessibleSlayerTaskMonsters(taskId);
        return this.evaluateAggregate('slayer-task', taskId, monsters, undefined, true, trials, ticks, deathAbortThreshold);
    }

    /**
     * Score a dungeon/stronghold/abyss-depth target: sim each of the area's monsters IN the area's
     * context (entityId = the area id, matching the chart's `simId(monster.id, areaId)` sims), then
     * average — see {@link evaluateAggregate}. A per-monster average is an approximation of a real
     * dungeon run: each fight sims fresh, so HP/food state does NOT carry over between fights. The
     * Simulate chart's dungeon bar makes exactly the same approximation.
     */
    private async evaluateDungeon(
        dungeonId: string,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        const monsters = Lookup.getMonsterList(dungeonId);
        return this.evaluateAggregate('dungeon', dungeonId, monsters, dungeonId, false, trials, ticks, deathAbortThreshold);
    }

    /**
     * Shared aggregate scorer behind {@link evaluateSlayerTask} and {@link evaluateDungeon}: sim
     * each monster of the aggregate individually (against `simEntityId` — undefined for a task's
     * plain-monster fights, the area id for a dungeon's in-context fights), then fold the results
     * into one averaged {@link SimulationData} via {@link Simulation.averageMonsterData} — the same
     * math the Simulate chart uses — and read the plotted metric off it. Monsters whose sim failed
     * are kept as `simSuccess:false` entries so the averager skips them.
     */
    private async evaluateAggregate(
        kind: 'slayer-task' | 'dungeon',
        entityId: string,
        monsters: Monster[],
        simEntityId: string | undefined,
        isSlayerTask: boolean,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        if (monsters.length === 0) {
            Global.logger.warn(`Optimizer ${kind} sim: no simmable monsters`, { entityId });
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        // A dungeon's monster list repeats a monster once per fight; sim each DISTINCT monster once
        // (the Simulate queue does the same via its inQueue guard) and let the averager weight it by
        // occurrence. Task lists are already distinct, so this is a no-op there.
        const uniqueMonsters = [...new Map(monsters.map(monster => [monster.id, monster])).values()];

        const dataByMonster = new Map<string, SimulationData>();
        let anySuccess = false;
        // Aggregate scoring already sims many monsters, so it isn't batched (batches=1): the
        // significance gate simply falls back to the fixed minImprovement margin here.
        if (this.pool) {
            // The setup is identical for every monster, so the (heavy) save decode is done once and
            // each monster becomes one request the pool sims concurrently — an ~N-monster speedup with
            // the pool that was otherwise idle on this path. Per-request failures are captured, not fatal.
            const saveString = Global.game.generateSaveStringSimple();
            const requests: SimulateRequest[] = uniqueMonsters.map(monster => ({
                saveString,
                monsterId: monster.id,
                entityId: simEntityId as string,
                trials,
                maxTicks: ticks,
                deathAbortThreshold,
                batches: undefined
            }));
            const settled = await this.pool.simulateManySettled(requests);
            settled.forEach((result, i) => {
                const monster = uniqueMonsters[i];
                const datas = result.ok
                    ? this.responseToDatas(result.value, monster.id, simEntityId, trials, ticks)
                    : undefined;
                const data = datas?.[0];
                if (data) {
                    anySuccess = true;
                }
                dataByMonster.set(monster.id, data ?? Global.simulation.newSimDataEntry(true));
            });
        } else {
            for (const monster of uniqueMonsters) {
                const datas = await this.runSim(monster.id, simEntityId, trials, ticks, deathAbortThreshold);
                const data = datas?.[0];
                if (data) {
                    anySuccess = true;
                }
                dataByMonster.set(monster.id, data ?? Global.simulation.newSimDataEntry(true));
            }
        }

        if (!anySuccess) {
            Global.logger.warn(`Optimizer ${kind} sim: every monster failed`, {
                entityId,
                monsters: uniqueMonsters.length
            });
            return { metric: NaN, deathRate: Infinity, success: false };
        }

        const averageData = Global.simulation.newSimDataEntry(false);
        Global.simulation.averageMonsterData(
            averageData,
            monsters,
            isSlayerTask,
            entityId,
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
        deathAbortThreshold?: number,
        batches = 1
    ): Promise<SimulationData[] | undefined> {
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
                deathAbortThreshold,
                batches: batches > 1 ? batches : undefined
            });
        } catch (error) {
            Global.logger.warn('Optimizer sim threw', { monsterId, entityId, error });
            return undefined;
        }

        return this.responseToDatas(response, monsterId, entityId, trials, ticks);
    }

    /**
     * Turn a worker {@link SimulateResponse} into the per-batch {@link SimulationData} the scorer
     * folds. Filters out failed sub-runs (logging the first failure reason), and back-fills the
     * realm id realmed plot types need. Shared by the serial ({@link runSim}) and parallel
     * ({@link evaluateBatch}) paths. Returns `undefined` if every sub-run failed.
     */
    private responseToDatas(
        response: SimulateResponse | undefined,
        monsterId: string,
        entityId: string | undefined,
        trials: number,
        ticks: number
    ): SimulationData[] | undefined {
        // batchResults carries one entry per sub-run (variance); a single run has just `result`.
        const raw = (response?.batchResults?.length ? response.batchResults : [response?.result]) as (
            | SimulationData
            | undefined
        )[];
        const datas = raw.filter((data): data is SimulationData => !!data && data.simSuccess);
        if (datas.length === 0) {
            Global.logger.warn('Optimizer sim failed', {
                monsterId,
                entityId,
                trials,
                ticks,
                reason: (response?.result as SimulationData | undefined)?.reason ?? 'no result returned'
            });
            return undefined;
        }

        // Realmed plot types (XP, etc.) need data.realmId. The worker already sets it from the
        // monster's area realm; derive it the same way if it's ever missing (once, shared by batches).
        if (datas.some(data => data.realmId === undefined)) {
            const monster = Global.game.monsters.getObjectByID(monsterId);
            const realmId = monster ? Global.game.getMonsterArea(monster).realm.id : undefined;
            for (const data of datas) {
                if (data.realmId === undefined) {
                    data.realmId = realmId;
                }
            }
        }

        return datas;
    }

    /**
     * Parallel candidate evaluation (§2d): score several setups at once across the worker {@link pool}.
     * Each setup is a `Settings` snapshot; it's imported and serialized to a save string on the main
     * thread (serial + cheap, no sim), then all save strings are simmed CONCURRENTLY across the pool.
     * Results are folded exactly like {@link evaluate}, so a candidate scores identically whether it
     * ran serially or in a batch. Bound to {@link evaluateBatch} only when a pool is present.
     *
     * Aggregate targets (slayer tasks, dungeons/strongholds/depths) aren't single-entity sims (they
     * average many monsters), so they fall back to serial evaluation here — where each candidate's
     * per-monster sims still fan out across the pool. The parallelism win of THIS path is on the
     * common single-monster case.
     */
    private async runBatch(
        setups: unknown[],
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation[]> {
        if (!this.pool || slayerTaskTargetId(target) || dungeonTargetId(target)) {
            const out: Evaluation[] = [];
            for (const setup of setups) {
                SettingsController.import(setup as Settings);
                out.push(await this.evaluate(target, trials, ticks, deathAbortThreshold));
            }
            return out;
        }

        const batches = this.resolveBatches(trials);
        // Import each setup and capture its save string (mutates the shared sim world, so this must be
        // sequential). Each iteration is a full settings import + save serialization on the main
        // thread, so yield periodically — a big dimension would otherwise freeze the page.
        const requests: SimulateRequest[] = [];
        for (const setup of setups) {
            SettingsController.import(setup as Settings);
            requests.push({
                saveString: Global.game.generateSaveStringSimple(),
                monsterId: target.monsterId,
                entityId: target.entityId as string,
                trials,
                maxTicks: ticks,
                deathAbortThreshold,
                batches: batches > 1 ? batches : undefined
            });
            if (requests.length % YIELD_STRIDE === 0) {
                await yieldToEventLoop();
            }
        }

        // Per-request error capture: one failed worker request must fail only ITS candidate, not the
        // whole dimension's batch (a rejecting simulateMany would return all-NaN for every candidate).
        const settled = await this.pool.simulateManySettled(requests);

        const failures = settled.filter((r): r is { ok: false; error: unknown } => !r.ok);
        if (failures.length > 0) {
            Global.logger.warn('Optimizer parallel sim: some requests failed', {
                failed: failures.length,
                total: settled.length,
                firstError: failures[0].error
            });
        }

        return settled.map(result => {
            if (!result.ok) {
                return { metric: NaN, deathRate: Infinity, success: false };
            }
            const datas = this.responseToDatas(result.value, target.monsterId, target.entityId, trials, ticks);
            return datas ? this.foldBatches(datas) : { metric: NaN, deathRate: Infinity, success: false };
        });
    }

    public isMaximize(): boolean {
        return !MINIMIZE_KEYS.has(Global.stores.plotter.plotType.key);
    }
}

/** Owned + valid-for-slot + currently-equippable candidate items for a slot. */
export class GameCandidateProvider implements CandidateProvider {
    /** Lazily-built set of item ids the character is a high enough skill level to craft (see craftableIds). */
    private _craftable?: Set<string>;

    constructor(
        /**
         * Which items the search may draw from: `owned` (found), `craftable` (owned OR high enough
         * skill level to craft), or `all` (every equippable item).
         */
        private readonly itemPool: ItemPool = 'owned',
        /**
         * Which attack type the weapon search is constrained to. Default `current` keeps the search on
         * the character's configured attack type (so a magic build isn't handed a melee weapon); `any`
         * searches every type. Also gates the Quiver slot (ammo is only relevant to a ranged weapon).
         */
        private readonly attackTypeConstraint: AttackTypeConstraint = 'current'
    ) {}

    public getCandidates(slotId: string): string[] {
        const slot = Global.game.equipmentSlots.getObjectByID(slotId);
        if (!slot) {
            return [];
        }

        const player = Global.game.combat.player;
        // Attack-type target the weapon search must stay within (undefined = unconstrained).
        const attackTypeTarget = resolveAttackTypeConstraint(this.attackTypeConstraint, player.attackType);
        // The equipped weapon drives whether ammo is relevant and which ammo type fits.
        const weapon = player.equipment.getItemInSlot(WEAPON_SLOT) as any;
        const weaponIsRanged = !!weapon && weapon.id !== EMPTY_ITEM && weapon.attackType === 'ranged';
        const weaponAmmoRequired = weaponIsRanged ? weapon.ammoTypeRequired : undefined;

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
            if (!this.inPool(item.id)) {
                return false;
            }
            // Keep the weapon search on the chosen attack type (a weapon has a string attackType;
            // non-weapons don't, so they're never filtered here).
            if (!weaponAllowedByAttackType((item as any).attackType, attackTypeTarget)) {
                return false;
            }
            // Ammo is only useful to a matching ranged weapon — drop arrows/bolts for a melee or magic
            // build, and drop the wrong ammo type for the equipped bow/crossbow. Passive quiver items
            // (no ammoType) are unaffected.
            if (slotId === QUIVER_SLOT && !ammoUsableWithWeapon((item as any).ammoType, weaponIsRanged, weaponAmmoRequired)) {
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
        // First collapse combat-identical stat-pure items to a single representative: two effect-less
        // items with the same stat vector sim identically, so keeping both just wastes evaluations
        // (and lets the optimizer "recommend" a swap between equals). This also folds every item with
        // NO combat stats into one candidate (they all share the empty signature) instead of simming
        // each — the sim can't tell them apart. Then Pareto-prune the survivors.
        const deduped = dedupeBySignature(plain, item => statSignature(item.stats));
        // Dominance assumes higher-is-better on every stat; some keys (attackSpeed) are lower-is-better,
        // so project onto a uniform higher-is-better axis for the prune. Dedupe stays on the RAW stats —
        // it only merges identical vectors (direction-agnostic), and raw keeps the signature strings stable.
        const directional = deduped.map(p => ({ id: p.id, stats: directStatsForDominance(p.stats) }));
        const keys = [...new Set(directional.flatMap(p => Object.keys(p.stats)))];
        return [...special, ...pruneDominated(directional, keys).map(v => v.id)];
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

    /** Is an item allowed by the configured pool (owned / owned+craftable / all)? */
    private inPool(itemId: string): boolean {
        switch (this.itemPool) {
            case 'all':
                return true;
            case 'craftable':
                return this.isOwned(itemId) || this.craftableIds().has(itemId);
            case 'owned':
            default:
                return this.isOwned(itemId);
        }
    }

    /** Owned = ever found, per the live character (items are distinct instances across the two games). */
    private isOwned(itemId: string): boolean {
        const liveItem = Global.melvor.items.getObjectByID(itemId);
        return liveItem ? Global.melvor.stats.itemFindCount(liveItem) > 0 : false;
    }

    /**
     * Item ids the LIVE character is a high enough skill level to craft, built once and cached. Walks
     * every skill's recipes (Smithing/Fletching/Crafting/Runecrafting/Summoning all expose an `actions`
     * registry of product-bearing recipes) and keeps each product whose level requirement is met. This
     * is a skill-LEVEL check only (materials aren't considered, per the chosen pool semantics); items
     * you can craft but can't yet equip are still dropped by the equip-requirement filter above.
     */
    private craftableIds(): Set<string> {
        if (this._craftable) {
            return this._craftable;
        }
        const craftable = new Set<string>();
        for (const skill of Global.melvor.skills.allObjects as any[]) {
            const recipes = skill.actions?.allObjects as any[] | undefined;
            if (!recipes) {
                continue;
            }
            const skillLevel = skill.level ?? 0;
            const abyssalLevel = skill.abyssalLevel ?? 0;
            for (const recipe of recipes) {
                const product = recipe?.product;
                if (!product || typeof recipe.level !== 'number') {
                    continue;
                }
                const levelOk = skillLevel >= recipe.level;
                const abyssalOk = !recipe.abyssalLevel || abyssalLevel >= recipe.abyssalLevel;
                if (levelOk && abyssalOk) {
                    craftable.add(product.id);
                }
            }
        }
        this._craftable = craftable;
        return craftable;
    }
}

/**
 * A nominal target for the analytic PRE-RANK (§2b). Pre-ranking only ranks a slot's candidates
 * against each other, and every candidate faces the SAME real target — so the target's exact
 * hitpoints/evasion are a common factor that never changes the ORDER. We therefore score against a
 * fixed high-evasion nominal target, which reduces the surrogate to a clean, monotonic
 * `accuracy × avgDamage ÷ interval` gear-quality proxy (high evasion => hitChance ≈ 0.5·acc/eva, i.e.
 * proportional to accuracy). This deliberately sidesteps deriving real per-attack-type enemy evasion:
 * the pre-rank is only a cheap FILTER — the full simulator still scores the surviving top-K and has
 * the final say, and K provides the safety margin if the proxy misranks (e.g. a cross-damage-type
 * weapon swap). See `prerank.ts` / `analytic-scorer.ts`.
 */
const PRERANK_TARGET: TargetStats = { hitpoints: 1, evasion: 1e9 };

/**
 * Read the sim player's freshly-computed offensive stats into the surrogate's {@link CombatStats}.
 * The caller MUST have run `combat.computeAllStats()` after the last equip — the app's equip path
 * uses `isImporting=true`, which SKIPS the stat recompute (see GameLoadoutApplier.equipInternal), so
 * the stats would otherwise be stale.
 */
export function deriveCombatStats(player: { stats: any }): CombatStats {
    const s = player.stats;
    return {
        maxHit: s.maxHit,
        minHit: s.minHit,
        accuracy: s.accuracy,
        attackInterval: s.attackInterval
    };
}

/**
 * A `scoreItem(slotId, itemId)` for {@link PreRankingCandidateProvider}: equip the candidate on the
 * current background, recompute stats, read the surrogate metric, then restore. Cheap relative to a
 * worker sim (no IPC, no Monte-Carlo), so pre-ranking to a top-K is a net win. Returns NaN if the
 * candidate can't be scored (sorted to the bottom by the pre-ranker).
 */
export function makeGameScoreItem(
    applier: GameLoadoutApplier,
    metric: AnalyticMetric = 'kills'
): (slotId: string, itemId: string) => number {
    return (slotId, itemId) => {
        const snapshot = applier.snapshot();
        try {
            applier.equip(slotId, itemId);
            Global.game.combat.computeAllStats();
            const value = estimateMetric(deriveCombatStats(Global.game.combat.player), PRERANK_TARGET, metric);
            return Number.isFinite(value) ? value : NaN;
        } catch (error) {
            Global.logger.warn('Optimizer pre-rank scoreItem failed', { slotId, itemId, error });
            return NaN;
        } finally {
            applier.restore(snapshot);
        }
    };
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

    public unequip(slotId: string): void {
        const slot = Global.game.equipmentSlots.getObjectByID(slotId);
        const player = Global.game.combat.player;
        const current = player.equipment.equippedItems[slotId]?.item;
        if (!slot || !current || current.id === EMPTY_ITEM) {
            return; // unknown slot or already empty
        }
        // set 0 = the sim player's active equipment set (mirrors the equipItem set arg above).
        player.unequipItem(0, slot);
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
        // A ranged weapon can't attack without compatible ammo, so equipping one that leaves the
        // quiver empty/incompatible would sim as a dud. Auto-fit ammo so the candidate is evaluated
        // fairly (the Quiver dimension then optimizes it). No-op for melee/magic weapons + non-weapons.
        if (slotId === WEAPON_SLOT) {
            this.ensureCompatibleAmmo();
        }
    }

    /**
     * If a ranged weapon that needs ammo is equipped but the quiver has none (or the wrong type),
     * equip the best owned compatible ammo so the bow/crossbow can actually attack in the sim. Mirrors
     * what a player must do by hand; the optimizer's Quiver dimension refines the choice afterwards.
     */
    private ensureCompatibleAmmo(): void {
        const player = Global.game.combat.player;
        const weapon = player.equipment.getItemInSlot(WEAPON_SLOT) as any;
        if (!weapon || weapon.id === EMPTY_ITEM || weapon.attackType !== 'ranged' || weapon.ammoTypeRequired == null) {
            return;
        }
        const quiver = player.equipment.getItemInSlot(QUIVER_SLOT) as any;
        if (quiver && quiver.id !== EMPTY_ITEM && quiver.ammoType === weapon.ammoTypeRequired) {
            return; // already compatible
        }
        const ammo = this.bestCompatibleAmmo(weapon.ammoTypeRequired);
        const quiverSlot = Global.game.equipmentSlots.getObjectByID(QUIVER_SLOT);
        if (ammo && quiverSlot) {
            player.equipItem(ammo, 0, quiverSlot, 1, true);
        }
    }

    /** Highest-ranged-power owned ammo of the required type that fits the quiver, or undefined. */
    private bestCompatibleAmmo(ammoTypeRequired: number): any {
        let best: any;
        let bestScore = -Infinity;
        for (const item of Global.game.items.equipment.allObjects) {
            const ammo = item as any;
            if (ammo.ammoType !== ammoTypeRequired) {
                continue;
            }
            if (!item.validSlots.some(valid => valid.id === QUIVER_SLOT)) {
                continue;
            }
            if (!item.isModded && !Global.game.checkRequirements(item.equipRequirements, false)) {
                continue;
            }
            if (!isItemOwned(item.id)) {
                continue;
            }
            let score = 0;
            for (const stat of item.equipmentStats ?? []) {
                if (stat.key === 'rangedStrengthBonus' || stat.key === 'rangedAttackBonus') {
                    score += stat.value;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }
        return best;
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

/**
 * Combat signature of a food for de-duplication. A food with any stat bonus keeps a UNIQUE signature
 * (its buffs matter and may differ from another food's), so buffed foods are never merged. A pure-heal
 * food (no stats) is interchangeable with any other that heals the same amount, so those collapse to a
 * single `heal:<amount>` bucket — no point simming five identical shrimps. (`hasStats` covers
 * modifiers / enemyModifiers / combatEffects / conditionalModifiers.)
 */
function foodSignature(food: any): string {
    return food.stats?.hasStats ? `id:${food.id}` : `heal:${food.healsFor}`;
}

/** Food dimension: the equipped combat food (owned), de-duplicated to combat-distinct options. */
function foodDimension(ownedOnly: boolean): Dimension {
    return settingsDimension(
        'food',
        'Food',
        settings => settings.foodSelected,
        (settings, value) => (settings.foodSelected = value as string),
        () => {
            const foods = Global.game.items.food.allObjects.filter(item => !ownedOnly || isItemOwned(item.id));
            // Drop combat-identical duplicates so we don't waste sims (and don't invite a pointless
            // recommendation to swap between interchangeable foods).
            return dedupeBySignature(foods, foodSignature).map(item => item.id);
        },
        choice => (choice ? Global.game.items.getObjectByID(choice as string)?.name ?? String(choice) : 'no food')
    );
}

/** The human-readable familiar name for a summon tablet id (falls back to the raw id). */
function summonName(itemId: string): string {
    return Global.game.items.getObjectByID(itemId)?.name ?? itemId;
}

/**
 * The summon tablet ids the character may currently equip into a summon slot: items valid for the
 * summon slot, meeting equip requirements, optionally restricted to owned. Mirrors the filtering in
 * {@link GameCandidateProvider} (the per-slot search uses the same rules), but collected here so the
 * compound dimension can hand the flat id set to the pure {@link enumerateSummonChoices}. We don't
 * run the dominance prune: a synergy familiar's value lives in its PAIR bonus (not its raw
 * equipmentStats), so pruning by solo stats could drop exactly the familiars we need.
 */
function availableSummonIds(ownedOnly: boolean): Set<string> {
    const ids = new Set<string>();
    for (const item of Global.game.items.equipment.allObjects) {
        if (item.id === EMPTY_ITEM || item.id === DEBUG_ITEM || item.golbinRaidExclusive) {
            continue;
        }
        if (!item.validSlots.some(slot => slot.id === SUMMON_SLOT_1 || slot.id === SUMMON_SLOT_2)) {
            continue;
        }
        if (!item.isModded && !Global.game.checkRequirements(item.equipRequirements, false)) {
            continue;
        }
        if (ownedOnly && !isItemOwned(item.id)) {
            continue;
        }
        ids.add(item.id);
    }
    return ids;
}

/** Every combat-potion item id (each tier of each combat/abyssal-combat recipe), optionally owned-only. */
function combatPotionIds(ownedOnly: boolean): string[] {
    const ids: string[] = [];
    for (const recipe of Global.game.herblore.actions.allObjects) {
        const category = recipe.category.localID;
        if (category !== 'CombatPotions' && category !== 'AbyssalCombatPotions') {
            continue;
        }
        for (const potion of recipe.potions) {
            if (!ownedOnly || isItemOwned(potion.id)) {
                ids.push(potion.id);
            }
        }
    }
    return ids;
}

/**
 * A COMPOUND dimension that controls BOTH summon slots at once so the optimizer can discover
 * declared {@link SummoningSynergy} pairs that are only good TOGETHER. See `synergy.ts` for the WHY:
 * generic coordinate ascent changes one slot at a time and would never adopt either half of a pair.
 *
 * This runs ALONGSIDE the two independent summon-slot dimensions (they optimally handle solos and
 * additive non-synergy pairs), so it only offers what they can't reach: the empty baseline and the
 * declared synergy pairs (`includeSingles: false`). That keeps the extra cost to roughly the number
 * of declared pairs rather than re-searching combinations the per-slot moves already cover.
 *
 * - getCandidates: read `Global.game.summoning.synergies`, map each synergy's two `summons` to their
 *   `product` (the equippable tablet) ids => declared pairs; gather the available summon ids; hand
 *   both to the pure enumerator, which yields the empty option plus every pair whose members are
 *   both available.
 * - applyChoice: clear both summon slots, then equip the chosen tablet(s). Wrapped in try/catch +
 *   logger for graceful degradation (a failed apply just scores as the incumbent the optimizer
 *   restored, rather than breaking the run), mirroring {@link settingsDimension}.
 *
 * NOTE: the worker recomputes `isSynergyUnlocked` from the save string on simulate, so we don't (and
 * needn't) gate candidates on synergy-unlock here; an equipped-but-locked pair simply scores without
 * the bonus.
 */
export function summonSynergyDimension(applier: GameLoadoutApplier, ownedOnly: boolean): Dimension {
    const readChoice = (): SummonChoice => {
        const loadout = applier.getCurrentLoadout();
        return normalizeSummonChoice({ first: loadout.get(SUMMON_SLOT_1), second: loadout.get(SUMMON_SLOT_2) });
    };

    return {
        id: 'summon-pair',
        label: 'Summoning',
        getCandidates: (): SummonChoice[] => {
            // Defensive: this dimension is on by default and the synergy->product mapping isn't yet
            // verified against every content pack. If the data shape ever surprises us, fall back to
            // the empty option only (the per-slot summon dims still run) rather than breaking the run.
            let pairs: SummonPair[] = [];
            try {
                pairs = Global.game.summoning.synergies
                    .map(synergy => ({ a: synergy.summons[0]?.product?.id, b: synergy.summons[1]?.product?.id }))
                    .filter((pair): pair is SummonPair => !!pair.a && !!pair.b);
            } catch (error) {
                Global.logger.error(`Optimizer dimension 'summon-pair' failed to read synergies`, error);
            }
            // Pairs only: the two per-slot summon dimensions running alongside this one already cover
            // the empty / single / additive-pair cases, so singles here would just be wasted evals.
            return enumerateSummonChoices(pairs, availableSummonIds(ownedOnly), false);
        },
        getCurrentChoice: readChoice,
        applyChoice: (choice: unknown) => {
            // Graceful degradation: the optimizer restored the incumbent before this call, so a
            // failure here leaves the incumbent intact (scores as a no-op) rather than breaking the
            // whole run. Errors are logged, not silently swallowed — mirrors settingsDimension.
            try {
                const normalized = normalizeSummonChoice(choice as SummonChoice);
                // Clear both summon slots first so dropping a familiar (or swapping pairs) doesn't
                // leave a stale tablet equipped. Uses the player-level unequip (set 0), the same
                // set the applier's equipItem targets.
                const player = Global.game.combat.player;
                const slot1 = Global.game.equipmentSlots.getObjectByID(SUMMON_SLOT_1);
                const slot2 = Global.game.equipmentSlots.getObjectByID(SUMMON_SLOT_2);
                if (slot1) {
                    player.unequipItem(0, slot1);
                }
                if (slot2) {
                    player.unequipItem(0, slot2);
                }
                if (normalized.first) {
                    applier.equip(SUMMON_SLOT_1, normalized.first);
                }
                if (normalized.second) {
                    applier.equip(SUMMON_SLOT_2, normalized.second);
                }
            } catch (error) {
                Global.logger.error(`Optimizer dimension 'summon-pair' failed to apply a choice`, error);
            }
        },
        equals: (a: unknown, b: unknown) => summonChoicesEqual(a as SummonChoice, b as SummonChoice),
        describe: (choice: unknown) => {
            const normalized = normalizeSummonChoice(choice as SummonChoice);
            if (normalized.first && normalized.second) {
                return `${summonName(normalized.first)} + ${summonName(normalized.second)}`;
            }
            if (normalized.first) {
                return summonName(normalized.first);
            }
            return 'no familiars';
        }
    };
}

/** Potion dimension: the active combat potion (any tier), or none. Applied via Settings.potionID. */
function potionDimension(ownedOnly: boolean): Dimension {
    return settingsDimension(
        'potion',
        'Potion',
        settings => settings.potionID,
        (settings, value) => (settings.potionID = (value as string) || undefined),
        () => [undefined, ...combatPotionIds(ownedOnly)],
        choice => (choice ? Global.game.items.getObjectByID(choice as string)?.name ?? String(choice) : 'no potion')
    );
}

type PrayerFamily = 'normal' | 'unholy' | 'abyssal';

/** Prayers can only be combined within the same family (normal / unholy / abyssal). */
function prayerFamily(prayer: any): PrayerFamily {
    return prayer.isUnholy ? 'unholy' : prayer.isAbyssal ? 'abyssal' : 'normal';
}

/**
 * A prayer is a legal choice only if its skill level is met, it works with the player's *current*
 * damage type (weapon-dependent — so candidates are re-read as the search changes the weapon), and,
 * for unholy prayers, the player has enough unholy-enabling items equipped.
 */
function isUsablePrayer(prayer: any): boolean {
    const player = Global.game.combat.player;
    const skillId = Global.game.prayer.id;
    const levelOk = prayer.isAbyssal
        ? prayer.abyssalLevel <= player.skillAbyssalLevel.get(skillId)
        : prayer.level <= player.skillLevel.get(skillId);
    if (!levelOk) {
        return false;
    }
    if (!prayer.canUseWithDamageType(player.damageType)) {
        return false;
    }
    if (prayer.isUnholy && player.modifiers.allowUnholyPrayerUse < 2) {
        return false;
    }
    return true;
}

/**
 * Prayers as ONE dimension over valid prayer *sets* (0–2 prayers, all the same family). Modelled as
 * a set rather than two positional slots because the game stores active prayers as an unordered list
 * (`Settings.prayerSelected`), so positional slots would shift whenever one is cleared. Candidates
 * are state-dependent (usable prayers depend on the equipped weapon), which the optimizer re-reads
 * each pass. Applied via the verified `SettingsController.import` path.
 */
function prayerDimension(): Dimension {
    const sortIds = (ids: string[]) => [...ids].sort();
    const key = (choice: unknown) => (choice as string[]).join(',');
    return {
        id: 'prayers',
        label: 'Prayers',
        getCandidates: () => {
            const usable = Global.game.prayers.allObjects.filter(isUsablePrayer);
            const sets: string[][] = [[]]; // "no prayers" is always an option
            for (const prayer of usable) {
                sets.push([prayer.id]);
            }
            // Same-family pairs (the game caps active prayers at 2 and forbids mixing families).
            for (let i = 0; i < usable.length; i++) {
                for (let j = i + 1; j < usable.length; j++) {
                    if (prayerFamily(usable[i]) === prayerFamily(usable[j])) {
                        sets.push(sortIds([usable[i].id, usable[j].id]));
                    }
                }
            }
            return sets;
        },
        getCurrentChoice: () => sortIds(SettingsController.export().prayerSelected ?? []),
        applyChoice: (choice: unknown) => {
            try {
                const settings = SettingsController.export();
                settings.prayerSelected = (choice as string[]).slice();
                SettingsController.import(settings, { notify: false });
            } catch (error) {
                Global.logger.error(`Optimizer dimension 'prayers' failed to apply a choice`, error);
            }
        },
        equals: (a: unknown, b: unknown) => key(a) === key(b),
        describe: (choice: unknown) => {
            const ids = choice as string[];
            if (!ids.length) {
                return 'no prayers';
            }
            return ids.map(id => Global.game.prayers.getObjectByID(id)?.name ?? id).join(' + ');
        }
    };
}

/**
 * Magic (Alt. Magic) skill level gates every spell's unlock; abyssal attack spells use the abyssal
 * level track. A spell that requires an equipped item is only unlocked while that item is equipped.
 * Mirrors the game's own `_isUnlocked` (see the Spells config page).
 */
function isSpellUnlocked(spell: any, abyssal: boolean): boolean {
    const player = Global.game.combat.player;
    const magicId = Global.game.altMagic.id;
    const levelOk = abyssal
        ? player.skillAbyssalLevel.get(magicId) >= spell.abyssalLevel
        : player.skillLevel.get(magicId) >= spell.level;
    return levelOk && (spell.requiredItem === undefined || player.equipment.checkForItem(spell.requiredItem));
}

/**
 * An attack spell is a legal choice only if unlocked AND either its required item is equipped or its
 * spellbook works with the player's *current* damage type (weapon-dependent — so candidates are
 * re-read as the search changes the weapon). Mirrors the game's `_canEquip`/`_isUnlocked`.
 */
function isUsableAttackSpell(spell: any): boolean {
    const abyssal = spell.spellbook.id === 'melvorItA:Abyssal';
    if (!isSpellUnlocked(spell, abyssal)) {
        return false;
    }
    // isSpellUnlocked already guaranteed the required item (if any) is equipped, so a spell WITH a
    // required item is always usable; one without needs a damage-type-compatible spellbook.
    return (
        spell.requiredItem !== undefined ||
        spell.spellbook.canUseWithDamageType(Global.game.combat.player.damageType)
    );
}

/** Human-readable spell name for an id (falls back to the raw id, or `none` for the empty selection). */
function spellName(id: string, registry: any, none: string): string {
    return id ? registry.getObjectByID(id)?.name ?? id : none;
}

/**
 * Attack spell as ONE dimension over the usable attack spells. Only meaningful when the setup casts
 * Magic, so on a melee/ranged build (`attackType !== 'magic'`) it collapses to just the current
 * selection — no candidates, no wasted sims. Candidates are state-dependent (usable spells depend on
 * the equipped weapon's damage type), which the optimizer re-reads each pass. There is always an
 * attack spell selected (no "none"). Applied via the verified `SettingsController.import` path.
 */
function attackSpellDimension(): Dimension {
    return settingsDimension(
        'spell-attack',
        'Attack Spell',
        settings => settings.spells.attack,
        (settings, value) => (settings.spells.attack = (value as string) ?? ''),
        () => {
            const player = Global.game.combat.player;
            const current = SettingsController.export().spells.attack;
            // Attack spells only fire on Magic; leave the selection untouched otherwise.
            if (player.attackType !== 'magic') {
                return [current];
            }
            const ids = Global.game.attackSpells.allObjects.filter(isUsableAttackSpell).map(spell => spell.id);
            // Keep "leave as-is" reachable even if the current spell somehow fails the usable filter.
            return ids.includes(current) ? ids : [current, ...ids];
        },
        choice => spellName(choice as string, Global.game.attackSpells, 'default spell')
    );
}

/**
 * Curse and Aurora share a shape: an optional single spell (or none), gated on the character being
 * able to cast that class (`canCurse`/`canAurora` — magic-dependent) and the current attack spellbook
 * permitting it (`allowCurses`/`allowAuroras`; e.g. Ancient magic forbids curses). When it can't be
 * cast, the dimension collapses to the current selection so the search wastes no sims. Unlock mirrors
 * the game's `_isUnlocked`. Applied via the verified `SettingsController.import` path.
 */
function optionalSpellDimension(
    id: string,
    label: string,
    registry: any,
    get: (settings: Settings) => string,
    set: (settings: Settings, value: string) => void,
    canCast: () => boolean,
    bookAllows: (book: any) => boolean,
    none: string
): Dimension {
    return settingsDimension(
        id,
        label,
        get,
        (settings, value) => set(settings, (value as string) ?? ''),
        () => {
            const player = Global.game.combat.player;
            const current = get(SettingsController.export());
            if (!canCast() || !bookAllows(player.spellSelection.attack?.spellbook)) {
                return [current || ''];
            }
            const ids = registry.allObjects
                .filter((spell: any) => isSpellUnlocked(spell, false))
                .map((spell: any) => spell.id);
            const withNone = ['', ...ids]; // '' is the always-available "no spell" option
            return withNone.includes(current) ? withNone : [current, ...withNone];
        },
        choice => spellName(choice as string, registry, none)
    );
}

/** Curse dimension: the active curse (or none). */
function curseSpellDimension(): Dimension {
    return optionalSpellDimension(
        'spell-curse',
        'Curse',
        Global.game.curseSpells,
        settings => settings.spells.curse,
        (settings, value) => (settings.spells.curse = value),
        () => Global.game.combat.player.canCurse,
        book => book?.allowCurses !== false,
        'no curse'
    );
}

/** Aurora dimension: the active aurora (or none). */
function auroraSpellDimension(): Dimension {
    return optionalSpellDimension(
        'spell-aurora',
        'Aurora',
        Global.game.auroraSpells,
        settings => settings.spells.aurora,
        (settings, value) => (settings.spells.aurora = value),
        () => Global.game.combat.player.canAurora,
        book => book?.allowAuroras !== false,
        'no aurora'
    );
}

/**
 * Attack style as ONE dimension over the styles legal for the CURRENT weapon's attack type (stab /
 * slash / block for melee, the ranged/magic variants otherwise). The game keeps one selected style per
 * attack type in `Settings.styles` ({ melee, ranged, magic }); only the entry matching the player's
 * present attack type is live, so this dimension reads/writes THAT key and re-reads the legal set each
 * pass (the search changes the weapon, and thus the attack type). Mirrors the config page's attack-style
 * dropdown (`_setAttackStyleDropdown`): candidates are `attackStyles` whose `attackType` equals the
 * player's current one. Applied via the verified `SettingsController.import` path.
 */
function attackStyleDimension(): Dimension {
    const styleKey = () => Global.game.combat.player.attackType as keyof Settings['styles'];
    return settingsDimension(
        'attack-style',
        'Attack Style',
        settings => settings.styles[styleKey()],
        (settings, value) => (settings.styles[styleKey()] = value as string),
        () => {
            const attackType = Global.game.combat.player.attackType;
            const current = SettingsController.export().styles[styleKey()];
            const ids = Global.game.attackStyles.allObjects
                .filter((style: any) => style.attackType === attackType)
                .map((style: any) => style.id);
            // Keep "leave as-is" reachable even if the current style somehow isn't in the legal set.
            return ids.includes(current) ? ids : [current, ...ids];
        },
        choice => Global.game.attackStyles.getObjectByID(choice as string)?.name ?? String(choice)
    );
}

/** True if the LIVE character has mastered (level ≥ 99) the given obstacle — mirrors getAgility. */
function obstacleMastered(obstacleId: string): boolean {
    const obstacle = Global.melvor.agility.actions.getObjectByID(obstacleId);
    return obstacle ? (Global.melvor.agility.actionMastery.get(obstacle)?.level ?? 0) >= 99 : false;
}

/**
 * One agility-course dimension: the obstacle built in a given category `slot` on `realmId`, or none.
 * Candidates are the obstacles in that category the LIVE character meets the level requirement for
 * (the sim maxes agility + unlocks every slot, so we gate on the real character instead — the analog
 * of the "craftable" gear pool). Applied by rewriting that category's entry in `Settings.agility`
 * and re-importing, exactly like {@link settingsDimension} but into the nested agility structure.
 */
function agilityObstacleDimension(realmId: string, category: number): Dimension {
    const readChoice = (): string => {
        const course = SettingsController.export().agility?.find(c => c.realmId === realmId);
        const entry = course?.obstacles.find(([, cat]) => cat === category);
        return entry ? entry[0] : '';
    };
    return {
        id: `agility-${category}`,
        label: `Agility Obstacle ${category + 1}`,
        getCandidates: (): string[] => {
            const level = Global.melvor.agility.level ?? 1;
            const abyssalLevel = Global.melvor.agility.abyssalLevel ?? 0;
            const ids = Global.game.agility.actions.allObjects
                .filter((o: any) => o.category === category && o.realm?.id === realmId)
                .filter((o: any) => o.level <= level && (!o.abyssalLevel || abyssalLevel >= o.abyssalLevel))
                .map((o: any) => o.id);
            return ['', ...ids]; // '' = leave the slot empty
        },
        getCurrentChoice: readChoice,
        applyChoice: (choice: unknown) => {
            // Graceful degradation like settingsDimension: a failed apply leaves the incumbent intact.
            try {
                const obstacleId = (choice as string) ?? '';
                const settings = SettingsController.export();
                if (!settings.agility) {
                    settings.agility = [];
                }
                let course = settings.agility.find(c => c.realmId === realmId);
                if (!course) {
                    course = { realmId, obstacles: [], pillars: [] } as AgilitySettings;
                    settings.agility.push(course);
                }
                // Replace this category's obstacle (drop the old entry, add the new one unless "none").
                course.obstacles = course.obstacles.filter(([, cat]) => cat !== category);
                if (obstacleId) {
                    course.obstacles.push([obstacleId, category, obstacleMastered(obstacleId)]);
                }
                SettingsController.import(settings, { notify: false });
            } catch (error) {
                Global.logger.error(`Optimizer dimension 'agility-${category}' failed to apply a choice`, error);
            }
        },
        equals: (a: unknown, b: unknown) => ((a as string) ?? '') === ((b as string) ?? ''),
        describe: (choice: unknown) => {
            const id = choice as string;
            return id ? Global.game.agility.actions.getObjectByID(id)?.name ?? id : 'none';
        }
    };
}

/**
 * Agility search dimensions for a realm: one per obstacle category the LIVE character has BOTH
 * unlocked (`numObstaclesUnlocked`) and can build at least one obstacle in. Empty when the character
 * hasn't unlocked any obstacle slots on this realm, so the staged agility pass simply no-ops. Realm
 * is the target monster's realm (courses are per-realm and the sim fights in one).
 */
export function agilityDimensions(realmId: string): Dimension[] {
    const realm = Global.game.realms.getObjectByID(realmId);
    const course = realm ? Global.game.agility.courses.get(realm) : undefined;
    if (!course) {
        return [];
    }
    // The sim unlocks every slot; respect the real character's unlocked count for a realistic search.
    const liveRealm = Global.melvor.realms.getObjectByID(realmId);
    const unlocked = (liveRealm ? Global.melvor.agility.courses.get(liveRealm)?.numObstaclesUnlocked : 0) ?? 0;
    const dims: Dimension[] = [];
    const slots = Math.min(course.obstacleSlots.length, unlocked);
    for (let category = 0; category < slots; category++) {
        const dim = agilityObstacleDimension(realmId, category);
        // Only search a category that has at least one buildable obstacle beyond "none".
        if (dim.getCandidates().length > 1) {
            dims.push(dim);
        }
    }
    return dims;
}

/**
 * Cartography search dimension: which discovered Point of Interest the character stands on (its
 * `activeStats` are applied to combat while positioned there). One dimension over the ACTIVE world
 * map's POIs — candidates are the discovered POIs that grant stats, plus "none" (starting location).
 * Empty (so no dimension) when Atlas of Discovery isn't active, there's no active map, or the
 * character hasn't discovered any stat-granting POI. Applied via the verified `SettingsController`
 * path (a single `cartographyPointOfInterest` field), so it's a plain {@link settingsDimension}.
 */
export function cartographyDimensions(): Dimension[] {
    if (!Global.game.cartography?.activeMap) {
        return []; // AoD not active / no active map
    }
    const dim = settingsDimension(
        'cartography-poi',
        'Cartography POI',
        settings => settings.cartographyPointOfInterest ?? '',
        (settings, value) => (settings.cartographyPointOfInterest = (value as string) || ''),
        () => {
            const map = Global.game.cartography?.activeMap;
            if (!map) {
                return [''];
            }
            const liveMap = Global.melvor.cartography?.activeMap;
            const ids = map.pointsOfInterest.allObjects
                // Only POIs that actually buff combat, and only ones the live character has discovered.
                .filter((poi: any) => poi.activeStats?.hasStats)
                .filter((poi: any) => liveMap?.pointsOfInterest.getObjectByID(poi.id)?.isDiscovered ?? false)
                .map((poi: any) => poi.id);
            return ['', ...ids]; // '' = starting location / no POI
        },
        choice =>
            choice
                ? Global.game.cartography?.activeMap?.pointsOfInterest.getObjectByID(choice as string)?.name ??
                  String(choice)
                : 'no POI'
    );
    // Only worth a dimension when there's a discovered stat-POI to consider beyond "none".
    return dim.getCandidates().length > 1 ? [dim] : [];
}

/**
 * Build the optimizer's search dimensions for the live game: equipment (each slot) plus the enabled
 * consumable dimensions (food, potion, prayers) and spell dimensions (attack spell, curse, aurora).
 * The same `applier` is passed to the optimizer as its SetupApplier. Non-equipment dimensions reuse
 * the verified `SettingsController.import` path.
 *
 * `summonSynergy` (default TRUE) ADDS the compound {@link summonSynergyDimension} on top of the two
 * per-slot summon dimensions (which are always searched). The per-slot moves optimally handle solo
 * familiars and additive non-synergy pairs; the compound dimension adds only the declared SYNERGY
 * pairs those greedy moves can't reach — so the two together cover the whole summon subspace at a
 * cost of roughly one extra evaluation per declared pair. `preRankTopK` applies the analytic two-tier
 * pre-rank (§2b); `allowEmpty` lets the search leave a slot empty when that beats every item.
 */
export function buildDimensions(
    applier: GameLoadoutApplier,
    candidates: GameCandidateProvider,
    options: {
        ownedOnly?: boolean;
        food?: boolean;
        potion?: boolean;
        prayers?: boolean;
        attackStyle?: boolean;
        attackSpell?: boolean;
        curse?: boolean;
        aurora?: boolean;
        summonSynergy?: boolean;
        allowEmpty?: boolean;
        /** Analytic two-tier pre-rank: keep only the top-K candidates per slot by surrogate (§2b). 0/undefined = off. */
        preRankTopK?: number;
    } = {}
): Dimension[] {
    const ownedOnly = options.ownedOnly ?? true;
    const summonSynergy = options.summonSynergy ?? true;
    // Two-tier pre-rank: wrap the candidate provider so each slot only surfaces its top-K candidates
    // by the cheap analytic surrogate, and the expensive sim is spent on the finalists. A HEURISTIC
    // filter (unlike the sound dominance prune inside GameCandidateProvider), so it's off unless a K
    // is given; the equipped item is retained so "leave as-is" stays reachable.
    const provider: GameCandidateProvider | PreRankingCandidateProvider =
        options.preRankTopK && options.preRankTopK > 0
            ? new PreRankingCandidateProvider(
                  candidates,
                  makeGameScoreItem(applier),
                  options.preRankTopK,
                  slotId => applier.getCurrentLoadout().get(slotId)
              )
            : candidates;
    // allowEmpty (default TRUE for the real game) lets the search leave a slot empty when that beats
    // every item — the sim decides. Coordinate ascent could otherwise only swap, never unequip. The
    // summon slots are ALWAYS searched independently (no exclusion); the compound synergy dimension
    // below is additive, not a replacement, so solo/additive-pair coverage is never lost.
    const dims = equipmentDimensions(applier, provider, slotLabel, undefined, options.allowEmpty ?? true);
    if (summonSynergy) {
        dims.push(summonSynergyDimension(applier, ownedOnly));
    }
    if (options.food ?? true) {
        dims.push(foodDimension(ownedOnly));
    }
    if (options.potion ?? true) {
        dims.push(potionDimension(ownedOnly));
    }
    if (options.prayers ?? true) {
        dims.push(prayerDimension());
    }
    if (options.attackStyle ?? true) {
        dims.push(attackStyleDimension());
    }
    if (options.attackSpell ?? true) {
        dims.push(attackSpellDimension());
    }
    if (options.curse ?? true) {
        dims.push(curseSpellDimension());
    }
    if (options.aurora ?? true) {
        dims.push(auroraSpellDimension());
    }
    return dims;
}
