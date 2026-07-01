/**
 * Multi-start coordinate ascent (auto-optimize feature 1a).
 *
 * WHY: {@link CoordinateAscentOptimizer} is greedy — it judges every early slot pick against
 * whatever gear the world *currently* holds. A bad starting basin can therefore trap it in a
 * COLD-START LOCAL OPTIMUM: the first improving move it can see forecloses a coupled second move
 * that would have led somewhere strictly better. Coordinate ascent from a single start cannot
 * escape this, because it only ever moves uphill from where it began.
 *
 * The classic fix is to RESTART the same local search from several different seeds and keep the
 * best feasible result. Different seeds drop the search into different basins; as long as at least
 * one seed lands in (or adjacent to) the global basin, the multi-start finds the global optimum
 * even though any individual run might not.
 *
 * Purity: this module depends ONLY on the injected optimizer/applier/scorer and the `types.ts`
 * interfaces — no `Global.*`/game imports — so it runs headless under vitest with the fakes, just
 * like the optimizer it wraps.
 */
import {
    CancelToken,
    OptimizeOptions,
    OptimizeResult,
    OptimizeTarget,
    ProgressCallback,
    Scorer,
    SetupApplier
} from 'src/app/optimizer/types';
import { CoordinateAscentOptimizer } from 'src/app/optimizer/optimizer';

/**
 * A starting state for one local search. The snapshot is an OPAQUE token of the kind
 * {@link SetupApplier.snapshot} returns — the caller produces it (e.g. by applying a candidate
 * loadout then snapshotting) and we hand it straight back to {@link SetupApplier.restore}. We never
 * inspect its contents, so the seed mechanism is agnostic to what a "setup" actually contains
 * (equipment, prayers, potion, food, …).
 */
export interface Seed {
    /** Stable identifier used in the result + per-seed summary (for reporting). */
    readonly id: string;
    /** Human-readable label (defaults to `id` in reports if absent). */
    readonly label?: string;
    /** Opaque restorable token from `applier.snapshot()` that defines this start state. */
    readonly snapshot: unknown;
}

/** One row of the per-seed report: how the local search launched from that seed turned out. */
export interface SeedSummary {
    readonly id: string;
    readonly label?: string;
    /** The seed's finalized directed-metric value (`OptimizeResult.bestMetric`). NaN if the run failed. */
    readonly bestMetric: number;
    /** The seed's finalized death rate (`OptimizeResult.bestDeathRate`). */
    readonly bestDeathRate: number;
    /** True if the converged result satisfies the death-rate constraint. */
    readonly feasible: boolean;
    /** The full result of the run from this seed (useful for callers that want more than the summary). */
    readonly result: OptimizeResult;
}

export interface MultiStartResult {
    /** The winning run's full {@link OptimizeResult} (the best feasible-or-least-dying outcome). */
    readonly best: OptimizeResult;
    /** The id of the seed that produced {@link best}. */
    readonly bestSeedId: string;
    /** One summary per seed actually run, in seed order (seeds skipped by cancellation are omitted). */
    readonly seedSummaries: SeedSummary[];
    /** True if cancellation stopped us before every seed was launched. */
    readonly cancelled: boolean;
}

/** Progress for the outer multi-start loop, distinct from the optimizer's per-pass progress. */
export interface MultiStartProgress {
    /** 1-based index of the seed about to run. */
    readonly seedIndex: number;
    /** Total number of seeds supplied. */
    readonly seedCount: number;
    /** The id of the seed about to run. */
    readonly seedId: string;
}

export type MultiStartProgressCallback = (progress: MultiStartProgress) => void;

/**
 * Local mirror of `CoordinateAscentOptimizer.better()` (the optimizer keeps that method private,
 * and the task forbids modifying it/types.ts, so we re-implement the *same* total order here).
 *
 * Ordering, strongest signal first:
 *  1. FEASIBILITY dominates — a feasible result beats any infeasible one outright. A result is
 *     feasible iff its death rate is within tolerance.
 *  2. Among feasible results, the DIRECTED metric decides: bigger is better when maximizing,
 *     smaller when minimizing.
 *  3. Among infeasible results, prefer the one CLOSER TO SURVIVING (lower death rate), so a
 *     hopeless landscape still returns the least-bad option rather than an arbitrary one.
 *
 * Returns true iff `a` is strictly better than `b`. (No `minImprovement` margin here: that guard
 * exists inside a single run to resist sim noise when accepting a swap; across seeds we simply want
 * the genuinely best converged result.)
 */
function isBetterResult(a: OptimizeResult, b: OptimizeResult, maximize: boolean, deathRateThreshold: number): boolean {
    const aFeasible = isFeasible(a, deathRateThreshold);
    const bFeasible = isFeasible(b, deathRateThreshold);
    if (aFeasible !== bFeasible) {
        return aFeasible;
    }
    if (aFeasible) {
        // Direct the metric the same way the optimizer does: a usable run has a finite bestMetric.
        const aVal = directed(a.bestMetric, maximize);
        const bVal = directed(b.bestMetric, maximize);
        return aVal > bVal;
    }
    return a.bestDeathRate < b.bestDeathRate;
}

/** A run is feasible iff it produced a usable metric and its death rate is within tolerance. */
function isFeasible(r: OptimizeResult, deathRateThreshold: number): boolean {
    return !Number.isNaN(r.bestMetric) && r.bestDeathRate <= deathRateThreshold;
}

/** Direct a raw metric so that "bigger is better" always holds; NaN sinks to the bottom. */
function directed(metric: number, maximize: boolean): number {
    if (Number.isNaN(metric)) {
        return -Infinity;
    }
    return maximize ? metric : -metric;
}

/**
 * Run `optimizer` from each seed in turn and return the best feasible-or-least-dying result.
 *
 * Snapshot/restore protocol (mirrors how the optimizer protects the user's gear):
 *  1. Capture the user's ORIGINAL setup up front.
 *  2. For each seed: `restore(seed.snapshot)` to install the start state, then `optimizer.run(...)`.
 *     The optimizer snapshots ITS baseline from the live world (i.e. the seed), optimizes from
 *     there, and restores back to the seed in its own `finally` — so each seed run is isolated and
 *     leaves the world on its seed.
 *  3. After all seeds (or on cancellation), `restore(original)` in a `finally` so the user's real
 *     configuration is byte-for-byte untouched regardless of how the search went.
 *
 * Cancellation: the same {@link CancelToken} is threaded into each `optimizer.run` AND checked
 * between seeds, so a cancel both stops the in-flight run and prevents launching further seeds.
 *
 * @param optimizer  the local search to restart (already wired with its scorer/dimensions/applier).
 * @param applier    the SAME applier the optimizer uses — needed to install seeds and to restore.
 * @param scorer     used only for `isMaximize()`, to direct the cross-seed comparison correctly.
 * @param target     what to simulate against (passed through unchanged).
 * @param seeds      caller-supplied start states. With zero seeds the result is an error-shaped run.
 * @param options    optimizer options; `deathRateThreshold` also defines cross-seed feasibility.
 * @param onProgress optional per-seed progress (the optimizer's own progress is not forwarded here).
 * @param cancel     cooperative cancellation token, threaded through and checked between seeds.
 */
export async function multiStart(
    optimizer: CoordinateAscentOptimizer,
    applier: SetupApplier,
    scorer: Scorer,
    target: OptimizeTarget,
    seeds: Seed[],
    options: Partial<OptimizeOptions> = {},
    onProgress?: MultiStartProgressCallback,
    cancel?: CancelToken
): Promise<MultiStartResult> {
    if (seeds.length === 0) {
        throw new Error('multiStart requires at least one seed');
    }

    const maximize = scorer.isMaximize();
    // Feasibility tolerance must match what the optimizer uses internally for the comparison to
    // agree with each run's own notion of feasibility. Defaults mirror DEFAULT_OPTIONS.
    const deathRateThreshold = options.deathRateThreshold ?? 0;

    // (1) Preserve the user's true starting configuration so we can always put it back.
    const original = applier.snapshot();

    const seedSummaries: SeedSummary[] = [];
    let best: OptimizeResult | undefined;
    let bestSeedId = '';
    let cancelled = false;

    try {
        for (let i = 0; i < seeds.length; i++) {
            // Stop launching new seeds once cancelled (an in-flight run already cooperatively bailed).
            if (cancel?.cancelled) {
                cancelled = true;
                break;
            }
            const seed = seeds[i];
            onProgress?.({ seedIndex: i + 1, seedCount: seeds.length, seedId: seed.id });

            // (2) Install this seed as the world's start state, then optimize from it. The optimizer
            // snapshots its own baseline from here and restores to here in its finally.
            applier.restore(seed.snapshot);
            const result = await optimizer.run(target, options, undefined, cancel);

            seedSummaries.push({
                id: seed.id,
                label: seed.label,
                bestMetric: result.bestMetric,
                bestDeathRate: result.bestDeathRate,
                feasible: isFeasible(result, deathRateThreshold),
                result
            });

            // Keep the best converged result across seeds (feasibility-first, then directed metric).
            if (best === undefined || isBetterResult(result, best, maximize, deathRateThreshold)) {
                best = result;
                bestSeedId = seed.id;
            }

            // If the just-finished run was itself cancelled, don't launch further seeds.
            if (result.status === 'cancelled' || cancel?.cancelled) {
                cancelled = true;
                break;
            }
        }
    } finally {
        // (3) Restore the user's real setup no matter what happened above.
        applier.restore(original);
    }

    // `best` is always defined here: we required >=1 seed and only `break` AFTER recording a result,
    // except the pre-loop cancellation check — but that can only fire on the first iteration when a
    // caller passes an already-cancelled token, which we guard below.
    if (best === undefined) {
        throw new Error('multiStart was cancelled before any seed could run');
    }

    return { best, bestSeedId, seedSummaries, cancelled };
}
