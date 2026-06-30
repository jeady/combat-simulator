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
    /**
     * @param deathAbortThreshold abort the underlying sim once this many deaths occur and return a
     * partial result (a fast path for infeasible setups). Infinity (the default) never aborts. The
     * optimizer only passes a finite value when it is *sound* to do so — i.e. the setup would
     * already exceed the death-rate tolerance — so an aborted result is always genuinely infeasible.
     */
    evaluate(
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation>;
    /** True if the selected objective is maximized (kills/hr, xp/hr); false to minimize (deathRate, food used). */
    isMaximize(): boolean;
}

/** Supplies the legal candidate item ids for a slot (owned + valid + usable). */
export interface CandidateProvider {
    getCandidates(slotId: string): string[];
}

/** Snapshot/restore the entire combat setup (equipment + prayers + potion + food + …). */
export interface SetupApplier {
    /** Capture restorable state (opaque token passed back to {@link restore}). */
    snapshot(): unknown;
    restore(snap: unknown): void;
}

/**
 * Mutates / snapshots the world's equipment. `applyLoadout` + `equip` may resolve
 * conflicts (2H weapon clears shield, weapon clears incompatible ammo), so callers must
 * read back the actual result via {@link getCurrentLoadout} after committing a change.
 */
export interface LoadoutApplier extends SetupApplier {
    /** The equipment slots, in a stable order. */
    slots(): SlotRef[];
    /** Current equipment as a fresh map (mutating it must not affect the world). */
    getCurrentLoadout(): EquipmentLoadout;
    /** Set the full equipment to exactly this map (unequip-all then equip each). */
    applyLoadout(loadout: EquipmentLoadout): void;
    /** Equip one item into a slot on top of the current loadout (may resolve conflicts). */
    equip(slotId: string, itemId: string): void;
}

/** A choice for a dimension — opaque to the optimizer (item id, prayer set, potion, food id…). */
export type DimensionChoice = unknown;

/**
 * One independently-searched coordinate of the setup — an equipment slot, the prayers, the
 * potion, the food, etc. The optimizer treats choices opaquely via these callbacks; each
 * Dimension reads/mutates the live (sim) world and knows its own choice type. Coordinate
 * ascent iterates dimensions generically (equipment slots are just one family of dimensions).
 */
export interface Dimension {
    readonly id: string;
    readonly label: string;
    /** Legal choices given the current world state (candidates may be state-dependent). */
    getCandidates(): DimensionChoice[];
    /** The choice currently applied to the world. */
    getCurrentChoice(): DimensionChoice;
    /** Apply a choice to the live world (may resolve conflicts; the optimizer re-snapshots after). */
    applyChoice(choice: DimensionChoice): void;
    /** Value-equality of two choices (to skip the no-op candidate and detect changes). */
    equals(a: DimensionChoice, b: DimensionChoice): boolean;
    /** Human-readable description of a choice (for the result diff). */
    describe(choice: DimensionChoice): string;
}

export interface DimensionChange {
    dimensionId: string;
    label: string;
    from: string;
    to: string;
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
    /**
     * Abort a search simulation as soon as it has accrued enough deaths to be *certainly* infeasible
     * (more than `deathRateThreshold` allows), instead of running every trial. Pure speed-up: the
     * abort threshold is derived from `deathRateThreshold` and the trial count, so it never discards
     * a setup that could still have ended feasible. The final re-score never aborts (so the reported
     * death rate is exact). Default true; set false to always run full trials. See
     * `docs/auto-optimize-search.md` §2a.
     */
    earlyStopOnDeath: boolean;
}

export const DEFAULT_OPTIONS: OptimizeOptions = {
    searchTrials: 200,
    searchTicks: 1000,
    finalTrials: 1000,
    finalTicks: 1000,
    maxPasses: 3,
    deathRateThreshold: 0,
    minImprovement: 0,
    earlyStopOnDeath: true
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

export interface OptimizeResult {
    status: 'completed' | 'cancelled' | 'aborted';
    /** Opaque snapshots (the real game uses Settings; fakes use the equipment map). */
    baselineSetup: unknown;
    bestSetup: unknown;
    baselineMetric: number;
    baselineDeathRate: number;
    bestMetric: number;
    bestDeathRate: number;
    /** Per-dimension changes from baseline to best. */
    dimensionDiff: DimensionChange[];
    evaluations: number;
    improved: boolean;
    message?: string;
}

/** Cooperative cancellation: the optimizer checks `cancelled` between evaluations. */
export interface CancelToken {
    cancelled: boolean;
}

export type ProgressCallback = (progress: OptimizeProgress) => void;
