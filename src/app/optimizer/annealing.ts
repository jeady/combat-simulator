/**
 * Simulated-annealing polish pass for the setup optimizer.
 *
 * WHY this exists: {@link CoordinateAscentOptimizer} is greedy coordinate ascent — it changes
 * exactly ONE dimension at a time and keeps a change only if it improves the score in isolation.
 * That is fast and reliable for convex-ish landscapes, but it is structurally blind to EMERGENT
 * synergies: two items in different slots that are each mediocre (or worse) on their own yet
 * strong TOGETHER, with no declared link telling the search to consider them jointly. Swapping in
 * either half alone looks like a regression, so coordinate ascent never crosses the ridge to the
 * joint optimum.
 *
 * This module adds a GLOBAL-MOVE search that perturbs MULTIPLE dimensions per step, so a single
 * proposal can flip both halves of a synergy at once and be judged on the combined result. It is
 * meant to run as a POLISH PASS seeded from the coordinate-ascent winner: annealing explores
 * outward from a good incumbent, occasionally accepting worse setups (Metropolis criterion) to
 * escape local optima, while always tracking the best-ever feasible setup seen.
 *
 * CRUX — "judge synergy by simulation, never by heuristic": every proposal is scored by actually
 * applying it to the world and running {@link Scorer.evaluate}. We never reason about *why* a pair
 * is good; we let the simulator tell us. The acceptance rule below is the heart of that: feasibility
 * is a HARD constraint (never traded away for metric, never softened by temperature), while the
 * directed metric is SOFT (worse-but-feasible moves may be accepted probabilistically to cross
 * ridges).
 *
 * PURE: depends only on the injected {@link Scorer}, {@link Dimension}[] and {@link SetupApplier}
 * interfaces — no game/`Global.*` dependency — so it runs headless under Node with fakes.
 */
import {
    CancelToken,
    Dimension,
    Evaluation,
    OptimizeTarget,
    ProgressCallback,
    Scorer,
    SetupApplier
} from 'src/app/optimizer/types';

/** Injected RNG so tests can seed it; defaults to `Math.random`. */
export type Random = () => number;

/** Tunable knobs for {@link simulatedAnnealing}. All optional; sane defaults below. */
export interface AnnealingOptions {
    /** Number of proposal/accept steps to attempt. Default 500. */
    iterations: number;
    /**
     * Starting temperature `T`. Higher = more willing to accept worsening feasible moves early.
     * The Metropolis probability is `exp(-worsening / T)`, so `T` should be on the same order of
     * magnitude as the metric worsenings you want to routinely tolerate. Default 10.
     */
    initialTemperature: number;
    /** Multiplicative cooldown applied to `T` each step, 0 < r < 1. Default 0.99. */
    coolingRate: number;
    /** Upper bound on how many distinct dimensions a single move may perturb (>=1). Default 2. */
    maxDimensionsPerMove: number;
    /** Trials per simulation (search fidelity). Default 200. */
    trials: number;
    /** Ticks per trial. Default 1000. */
    ticks: number;
    /** A setup is feasible only if `deathRate <= deathRateThreshold`. Default 0. */
    deathRateThreshold: number;
    /**
     * Require the best-ever feasible metric to improve by more than this before we report
     * `improved: true` (noise guard). Default 0.
     */
    minImprovement: number;
    /** Injected RNG (0..1). Default `Math.random`. */
    random: Random;
}

export const DEFAULT_ANNEALING_OPTIONS: AnnealingOptions = {
    iterations: 500,
    initialTemperature: 10,
    coolingRate: 0.99,
    maxDimensionsPerMove: 2,
    trials: 200,
    ticks: 1000,
    deathRateThreshold: 0,
    minImprovement: 0,
    random: Math.random
};

/** Result of an annealing run. Mirrors the load-bearing fields of `OptimizeResult`. */
export interface AnnealingResult {
    status: 'completed' | 'cancelled';
    /** Opaque snapshot of the original setup (as returned by `applier.snapshot()`). */
    baselineSetup: unknown;
    /** Opaque snapshot of the best setup found (feasible if any feasible was ever reached). */
    bestSetup: unknown;
    baselineMetric: number;
    baselineDeathRate: number;
    bestMetric: number;
    bestDeathRate: number;
    /** True iff the best-ever feasible setup strictly beats the baseline (by `minImprovement`). */
    improved: boolean;
    /** Total simulations run (baseline + every proposal). */
    evaluations: number;
}

/**
 * Internal comparable score. `feasible` dominates all comparisons; among feasible setups the
 * directed `value` (already sign-flipped for minimize objectives) decides; among infeasible ones
 * a lower `deathRate` is "less bad". Mirrors the optimizer's `Score`.
 */
interface Score {
    feasible: boolean;
    /** Directed metric: `+metric` when maximizing, `-metric` when minimizing; -Infinity if failed. */
    value: number;
    deathRate: number;
    /** The raw metric as reported by the sim (for result reporting). */
    rawMetric: number;
    /** The raw death rate as reported by the sim (for result reporting). */
    rawDeathRate: number;
}

/**
 * Simulated-annealing polish search over a set of {@link Dimension}s.
 *
 * @param scorer      evaluates the currently-applied world; direction via `isMaximize()`.
 * @param dimensions  the independently-perturbable coordinates (equipment slots, prayers, …).
 * @param applier     snapshot/restore of the whole setup (opaque tokens).
 * @param target      what to simulate against.
 * @param options     tunables (see {@link AnnealingOptions}); merged over defaults.
 * @param onProgress  coarse progress callback (invoked periodically, not every iteration).
 * @param cancel      cooperative cancellation, checked between iterations.
 */
export async function simulatedAnnealing(
    scorer: Scorer,
    dimensions: Dimension[],
    applier: SetupApplier,
    target: OptimizeTarget,
    options: Partial<AnnealingOptions> = {},
    onProgress?: ProgressCallback,
    cancel?: CancelToken
): Promise<AnnealingResult> {
    const opts: AnnealingOptions = { ...DEFAULT_ANNEALING_OPTIONS, ...options };
    const rng = opts.random;

    // Snapshot the ORIGINAL setup up front so `finally` can always restore the user's world,
    // independent of whatever the search leaves the live state in.
    const baselineSetup = applier.snapshot();
    let evaluations = 0;

    const score = async (): Promise<Score> => {
        const evaluation = await scorer.evaluate(target, opts.trials, opts.ticks);
        evaluations++;
        return toScore(evaluation, scorer.isMaximize(), opts.deathRateThreshold);
    };

    try {
        // Score the original setup: it is simultaneously the starting incumbent AND the best-ever.
        const baselineScore = await score();
        let incumbentScore = baselineScore;
        let incumbentSnap = applier.snapshot();

        // Best-ever tracking. We prefer the best FEASIBLE setup; only if no feasible setup is ever
        // found do we fall back to the lowest-death-rate infeasible one. `bestSnap` is a snapshot of
        // that setup so it survives later restores.
        let bestScore = baselineScore;
        let bestSnap = applier.snapshot();

        let temperature = opts.initialTemperature;
        let cancelled = false;

        // Emit coarse progress ~20 times over the run (plus start/end), never every iteration.
        const progressEvery = Math.max(1, Math.floor(opts.iterations / 20));
        const emit = (phase: 'searching' | 'done' | 'cancelled') =>
            onProgress?.({
                phase,
                pass: 0,
                slotIndex: 0,
                slotCount: dimensions.length,
                slotId: '',
                evaluations,
                bestMetric: bestScore.value === -Infinity ? NaN : bestScore.rawMetric,
                baselineMetric: baselineScore.rawMetric
            });

        emit('searching');

        for (let step = 0; step < opts.iterations; step++) {
            if (cancel?.cancelled) {
                cancelled = true;
                break;
            }

            // Always propose relative to the CURRENT incumbent: restore it, then perturb.
            applier.restore(incumbentSnap);
            proposeMove(dimensions, opts.maxDimensionsPerMove, rng);
            const proposalScore = await score();

            if (accept(incumbentScore, proposalScore, temperature, rng)) {
                // Snapshot the ACTUAL resulting setup (dimensions may resolve conflicts on apply).
                incumbentSnap = applier.snapshot();
                incumbentScore = proposalScore;

                // Update best-ever using the same feasibility-first ordering as the optimizer.
                if (isBetterBest(proposalScore, bestScore)) {
                    bestScore = proposalScore;
                    bestSnap = incumbentSnap;
                }
            }

            // Cool. Never let T hit 0 (would make exp(-x/T) undefined); coolingRate<1 keeps it >0.
            temperature *= opts.coolingRate;

            if (step % progressEvery === 0) {
                emit('searching');
            }
        }

        // `improved` compares the best-ever FEASIBLE result to the baseline. A run that only ever
        // reduced an infeasible death rate is not an "improvement" in the feasible sense unless it
        // actually reached feasibility.
        const improved =
            bestScore.feasible &&
            (!baselineScore.feasible || bestScore.value > baselineScore.value + opts.minImprovement);

        emit(cancelled ? 'cancelled' : 'done');

        return {
            status: cancelled ? 'cancelled' : 'completed',
            baselineSetup,
            bestSetup: bestSnap,
            baselineMetric: baselineScore.rawMetric,
            baselineDeathRate: baselineScore.rawDeathRate,
            bestMetric: bestScore.rawMetric,
            bestDeathRate: bestScore.rawDeathRate,
            improved,
            evaluations
        };
    } finally {
        // Always restore the user's original configuration, whatever the search left behind.
        applier.restore(baselineSetup);
    }
}

/**
 * Perturb 1..`maxDimensionsPerMove` DISTINCT randomly-chosen dimensions, applying a random
 * candidate to each. The caller has already restored the incumbent, so the world reflects the
 * incumbent before this runs and the proposed setup after.
 *
 * WHY multi-dimension moves: this is the whole point of annealing over coordinate ascent — a single
 * proposal can flip BOTH halves of an emergent synergy simultaneously, so the pair is judged jointly
 * by the simulator rather than each half being (correctly) rejected in isolation.
 */
function proposeMove(dimensions: Dimension[], maxDimensionsPerMove: number, rng: Random): void {
    if (dimensions.length === 0) {
        return;
    }
    const cap = Math.max(1, Math.min(maxDimensionsPerMove, dimensions.length));
    const count = 1 + Math.floor(rng() * cap); // 1..cap inclusive
    const picked = pickDistinct(dimensions.length, count, rng);
    for (const idx of picked) {
        const dim = dimensions[idx];
        const candidates = dim.getCandidates();
        if (candidates.length === 0) {
            continue;
        }
        const choice = candidates[Math.floor(rng() * candidates.length)];
        dim.applyChoice(choice);
    }
}

/** Pick `count` distinct indices from `[0, n)` via partial Fisher–Yates. `count` is clamped to n. */
function pickDistinct(n: number, count: number, rng: Random): number[] {
    const k = Math.min(count, n);
    const pool = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rng() * (n - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, k);
}

/**
 * The acceptance rule — the crux of the whole search.
 *
 * FEASIBILITY IS A HARD CONSTRAINT, never subject to temperature:
 *  - proposal feasible, incumbent infeasible  → ALWAYS accept (moving into the feasible region).
 *  - proposal infeasible, incumbent feasible  → NEVER accept (would abandon a survivable setup).
 *  - both feasible → the directed metric is SOFT:
 *        • improves (or ties)          → accept.
 *        • worsens by `d`              → accept with Metropolis probability `exp(-d / T)`.
 *  - both infeasible → no metric, no temperature: accept iff `deathRate` strictly decreases
 *    (steer toward feasibility). A tie/increase is rejected so we don't wander sideways.
 */
function accept(incumbent: Score, proposal: Score, temperature: number, rng: Random): boolean {
    // Cross-feasibility cases are decided purely by the hard constraint.
    if (proposal.feasible !== incumbent.feasible) {
        return proposal.feasible;
    }

    if (proposal.feasible) {
        // Both feasible: directed metric, higher `value` is better.
        const delta = proposal.value - incumbent.value;
        if (delta >= 0) {
            return true;
        }
        // Worsening feasible move: Metropolis. `-delta` is the positive worsening amount.
        const probability = Math.exp(delta / temperature);
        return rng() < probability;
    }

    // Both infeasible: only accept strict progress toward survivability.
    return proposal.deathRate < incumbent.deathRate;
}

/**
 * Feasibility-first "is `a` a better BEST than `b`?" ordering (deterministic, no temperature).
 * Feasibility dominates; among feasible, higher directed value; among infeasible, lower deathRate.
 * Used only to decide when to snapshot a new best-ever — distinct from {@link accept}, which drives
 * the (temperature-influenced) random walk.
 */
function isBetterBest(a: Score, b: Score): boolean {
    if (a.feasible !== b.feasible) {
        return a.feasible;
    }
    if (a.feasible) {
        return a.value > b.value;
    }
    return a.deathRate < b.deathRate;
}

/** Map a raw evaluation to a comparable {@link Score} (mirrors the optimizer's `toScore`). */
function toScore(evaluation: Evaluation, maximize: boolean, deathRateThreshold: number): Score {
    const usable = evaluation.success && !Number.isNaN(evaluation.metric);
    const value = !usable ? -Infinity : maximize ? evaluation.metric : -evaluation.metric;
    const feasible = usable && evaluation.deathRate <= deathRateThreshold;
    return {
        feasible,
        value,
        deathRate: usable ? evaluation.deathRate : Infinity,
        rawMetric: evaluation.metric,
        rawDeathRate: usable ? evaluation.deathRate : Infinity
    };
}
