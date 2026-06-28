/**
 * Core optimizer types and the small injected interfaces the search engine depends on.
 *
 * IMPORTANT: this module must stay free of any game/`Global.*`/`melvor-types` runtime
 * dependency so the search engine can run headless under Node (vitest) with fakes. The
 * real, game-backed implementations live in `adapters.ts` behind these interfaces.
 */

/** A full equipment loadout: slot id -> item id. Absent slot = empty. */
export type EquipmentLoadout = Map<string, string>;

/** Minimal structural handle for an equipment slot (the real `EquipmentSlot` satisfies this). */
export interface SlotRef {
    readonly id: string;
}

/** What we simulate against. `entityId` is the dungeon/task/etc id; undefined for a plain monster. */
export interface OptimizeTarget {
    readonly monsterId: string;
    readonly entityId?: string;
}

/** Raw outcome of evaluating the currently-applied loadout against the target. */
export interface Evaluation {
    /** The selected plot metric's raw value (already realm-resolved). NaN if the sim failed. */
    metric: number;
    /** Probability of death across trials, 0..1. */
    deathRate: number;
    /** False if the simulation did not produce a usable result. */
    success: boolean;
}

/**
 * Evaluates the loadout currently applied to the world. Implementations read the live
 * (sim) state — the optimizer applies a loadout via {@link LoadoutApplier} first, then
 * calls this. Direction (`isMaximize`) tells the search whether bigger metric is better.
 */
export interface Scorer {
    evaluate(target: OptimizeTarget, trials: number, ticks: number): Promise<Evaluation>;
    /** True if the selected objective is maximized (kills/hr, xp/hr); false to minimize (deathRate, food used). */
    isMaximize(): boolean;
}

/** Supplies the legal candidate item ids for a slot (owned + valid + usable). */
export interface CandidateProvider {
    getCandidates(slotId: string): string[];
}

/**
 * Mutates / snapshots the world's equipment. `applyLoadout` + `equip` may resolve
 * conflicts (2H weapon clears shield, weapon clears incompatible ammo), so callers must
 * read back the actual result via {@link getCurrentLoadout} after committing a change.
 */
export interface LoadoutApplier {
    /** Capture restorable state (opaque token passed back to {@link restore}). */
    snapshot(): unknown;
    restore(snap: unknown): void;
    /** The equipment slots, in a stable order. */
    slots(): SlotRef[];
    /** Current equipment as a fresh map (mutating it must not affect the world). */
    getCurrentLoadout(): EquipmentLoadout;
    /** Set the full equipment to exactly this map (unequip-all then equip each). */
    applyLoadout(loadout: EquipmentLoadout): void;
    /** Equip one item into a slot on top of the current loadout (may resolve conflicts). */
    equip(slotId: string, itemId: string): void;
}

export interface OptimizeOptions {
    searchTrials: number;
    searchTicks: number;
    finalTrials: number;
    finalTicks: number;
    /** Max coordinate-ascent passes over all slots. Default 3. */
    maxPasses: number;
    /** A loadout is feasible only if deathRate <= this. Default 0. */
    deathRateThreshold: number;
    /** Require this much directed-metric gain to accept a swap (noise guard). Default 0. */
    minImprovement: number;
}

export const DEFAULT_OPTIONS: OptimizeOptions = {
    searchTrials: 200,
    searchTicks: 1000,
    finalTrials: 1000,
    finalTicks: 1000,
    maxPasses: 3,
    deathRateThreshold: 0,
    minImprovement: 0
};

export type OptimizePhase = 'searching' | 'finalizing' | 'done' | 'cancelled' | 'aborted' | 'error';

export interface OptimizeProgress {
    phase: OptimizePhase;
    pass: number;
    slotIndex: number;
    slotCount: number;
    slotId: string;
    /** Total simulations run so far. */
    evaluations: number;
    bestMetric: number;
    baselineMetric: number;
    message?: string;
}

export interface SlotChange {
    slotId: string;
    fromItemId?: string;
    toItemId?: string;
}

export interface LoadoutScore {
    loadout: EquipmentLoadout;
    metric: number;
    deathRate: number;
}

export interface OptimizeResult {
    status: 'completed' | 'cancelled' | 'aborted';
    baseline: LoadoutScore;
    best: LoadoutScore;
    /** Slot-level differences from baseline to best. */
    diff: SlotChange[];
    evaluations: number;
    improved: boolean;
    message?: string;
}

/** Cooperative cancellation: the optimizer checks `cancelled` between evaluations. */
export interface CancelToken {
    cancelled: boolean;
}

export type ProgressCallback = (progress: OptimizeProgress) => void;
