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
    /**
     * Standard error of {@link metric} — the Monte-Carlo sampling uncertainty of this estimate (from
     * batch means over the trials). Lets the optimizer accept a swap only when the improvement is
     * statistically significant, not noise. Undefined when the scorer can't estimate it (e.g. the
     * analytic surrogate, or a run with too few trials to batch); the search then falls back to the
     * fixed `minImprovement` margin.
     */
    stdError?: number;
    /**
     * The worst single hit taken during the evaluation (the game's "Highest Hit Taken"). Used as a
     * survivability TIE-BREAKER: among candidates whose metrics are within the noise margin of each
     * other, the optimizer prefers the one with the lowest worst-hit — spike damage is what breaks
     * the auto-eat threshold, so this picks the safer of two equivalent setups. Never overrides a
     * genuine metric win. Undefined when the scorer doesn't measure it (e.g. the analytic surrogate).
     */
    highestDamageTaken?: number;
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
    /**
     * Like {@link evaluate}, but must bypass any memoization and run a genuinely fresh simulation;
     * implementations backed by a cache must overwrite the cached entry with the fresh result.
     */
    evaluateFresh?(
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation>;
    /** True if the selected objective is maximized (kills/hr, xp/hr); false to minimize (deathRate, food used). */
    isMaximize(): boolean;
    /**
     * Optional parallel path: evaluate several setups at once, returning evaluations aligned to the
     * input order. Each `setup` is an opaque {@link SetupApplier} snapshot (the same value
     * {@link SetupApplier.snapshot} returns). When a scorer implements this, the optimizer fans a
     * dimension's candidates across it (a worker pool sims them concurrently) instead of one at a
     * time; a scorer without it is always evaluated serially via {@link evaluate} (unchanged).
     */
    evaluateBatch?(
        setups: unknown[],
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation[]>;
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
    /** Empty a single slot (leave the rest of the loadout untouched). No-op if already empty. */
    unequip(slotId: string): void;
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
    /** Require this much directed-metric gain to accept a swap (absolute noise guard). Default 0. */
    minImprovement: number;
    /**
     * Require the directed metric to improve by at least this FRACTION of the incumbent's value (a
     * noise floor for scorers that can't estimate stdError). The accept margin is
     * max(minImprovement, minRelImprovement·|incumbent|, z·hypot(seA, seB)). Default 0.
     */
    minRelImprovement: number;
    /**
     * Confirm a candidate swap with a fresh replicate before committing it (winner's-curse guard).
     * A dimension evaluates dozens of noisy candidates and takes the best; max-of-N selection biases
     * the winner's estimate high, so a lucky roll can beat the incumbent by chance. When on (default)
     * and the scorer supports {@link Scorer.evaluateFresh}, the optimizer re-simulates the proposed
     * winner once more and only commits if the REPLICATE still clears the accept margin — and commits
     * with the replicate's (unbiased) score, not the lucky sample. Default true. See
     * `docs/auto-optimize-search.md`.
     */
    confirmSwaps: boolean;
    /**
     * Statistical-significance guard (§ significance). A swap is accepted only if the metric improves
     * by more than `significanceZ × combinedStandardError` (as well as `minImprovement`), so a change
     * that's within Monte-Carlo noise is never recommended — a status-quo bias toward the incumbent.
     * `z` is a normal quantile: 1.645 ≈ 95% one-sided (default), 1.0 ≈ 84%, 0 disables the guard.
     * Only bites when the scorer supplies `Evaluation.stdError`; otherwise it's a no-op.
     */
    significanceZ: number;
    /**
     * Abort a search simulation as soon as it has accrued enough deaths to be *certainly* infeasible
     * (more than `deathRateThreshold` allows), instead of running every trial. Pure speed-up: the
     * abort threshold is derived from `deathRateThreshold` and the trial count, so it never discards
     * a setup that could still have ended feasible. The final re-score never aborts (so the reported
     * death rate is exact). Default true; set false to always run full trials. See
     * `docs/auto-optimize-search.md` §2a.
     */
    earlyStopOnDeath: boolean;
    /**
     * Adaptive trials (§2e). When > 0, a slot's candidates are first SCREENED at this (low) trial
     * count, then only the best `screenKeep` are CONFIRMED at full `searchTrials`. Clear losers are
     * dropped after a cheap screen instead of paying a full evaluation each. 0 (default) = off (every
     * candidate is evaluated once at `searchTrials`). Only screens when a slot has more than
     * `screenKeep` candidates and `screenTrials < searchTrials`.
     */
    screenTrials: number;
    /** How many screened candidates advance to the full-trial confirm pass. Default 3. */
    screenKeep: number;
}

export const DEFAULT_OPTIONS: OptimizeOptions = {
    searchTrials: 200,
    searchTicks: 1000,
    finalTrials: 1000,
    finalTicks: 1000,
    maxPasses: 3,
    deathRateThreshold: 0,
    minImprovement: 0,
    minRelImprovement: 0,
    confirmSwaps: true,
    significanceZ: 1.645,
    earlyStopOnDeath: true,
    screenTrials: 0,
    screenKeep: 3
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

/**
 * A fine-grained event from the search loop, for live UI feedback (icon feeds, leaderboards, a
 * "currently evaluating" view). Distinct from {@link OptimizeProgress} (a coarse status tick): an
 * event carries the actual setup being judged so the UI can render its loadout.
 *
 * `choices` is the full per-dimension choice list of the evaluated setup (the incumbent with one
 * dimension swapped), aligned to the optimizer's `Dimension[]` order — cheap to reconstruct and
 * enough to render a loadout. On `best-improved`, `setup` additionally carries the accurate,
 * conflict-resolved snapshot (e.g. a 2H weapon having cleared the shield slot).
 */
export interface OptimizeEvent {
    type: 'evaluated' | 'best-improved';
    /** Per-dimension choices of the evaluated setup, aligned to the `Dimension[]` order. */
    choices: DimensionChoice[];
    /** Index of the dimension varied this evaluation; -1 for the baseline. */
    changedIndex: number;
    /** Raw (undirected) metric value the sim produced; NaN if it failed. */
    metric: number;
    deathRate: number;
    /** Survived (deathRate within threshold) and produced a usable metric. */
    feasible: boolean;
    /** Total simulations run so far (matches {@link OptimizeProgress.evaluations}). */
    evaluations: number;
    /** Standard error of {@link metric} for this evaluation, if the scorer estimated it. */
    stdError?: number;
    /**
     * Trial count this evaluation ran at. Screening-rung evaluations run below `searchTrials` and
     * are both noisier and max-selection biased, so consumers ranking setups (e.g. a leaderboard)
     * should skip or down-weight entries below full search fidelity.
     */
    trials?: number;
    /** Accurate conflict-resolved snapshot of the setup. Present on `best-improved`. */
    setup?: unknown;
}

export type EventCallback = (event: OptimizeEvent) => void;

export interface OptimizeResult {
    status: 'completed' | 'cancelled' | 'aborted';
    /** Opaque snapshots (the real game uses Settings; fakes use the equipment map). */
    baselineSetup: unknown;
    bestSetup: unknown;
    baselineMetric: number;
    baselineDeathRate: number;
    bestMetric: number;
    bestDeathRate: number;
    /**
     * True iff the final full-fidelity re-score satisfies the death-rate threshold; false means the
     * recommendation violates the survival constraint at higher fidelity.
     */
    bestFeasible: boolean;
    /** Standard error of {@link baselineMetric} from the baseline evaluation, if estimated. */
    baselineStdError?: number;
    /** Standard error of {@link bestMetric} from the final re-score, if estimated. */
    bestStdError?: number;
    /** Worst single hit taken by the baseline setup, if the scorer measured it. */
    baselineHighestDamageTaken?: number;
    /** Worst single hit taken by the best setup at the final re-score, if measured. */
    bestHighestDamageTaken?: number;
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
