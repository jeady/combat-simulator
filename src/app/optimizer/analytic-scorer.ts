/**
 * Tier-1 analytic surrogate scorer (P2).
 *
 * A FAST, closed-form estimate of a combat objective that does NOT run the Monte-Carlo
 * simulator. It is used to pre-rank a large set of gear candidates cheaply so the real
 * (expensive) sim is only spent on the most promising finalists — a two-tier flow:
 *
 *     analytic pre-rank (this module)  ->  full-sim top-K (GameScorer)
 *
 * IMPORTANT: every formula here is an APPROXIMATION. The constants and shapes are chosen to
 * be monotonic and directionally correct (more accuracy/maxHit -> better; tankier target ->
 * worse kills/sec; faster attacks -> more DPS), NOT to match the real sim's absolute numbers.
 * They are intended to be CALIBRATED later against the real simulator (e.g. fit a scale /
 * offset, or replace the hit-chance curve, once we have paired analytic-vs-sim samples).
 *
 * Like `optimizer.ts`, this module has NO game / `Global.*` / `melvor-types` dependency so it
 * stays unit-testable headless under vitest. The integration layer (an adapter that derives
 * `CombatStats` / `TargetStats` from the live `player`/`enemy` without running a sim) supplies
 * the inputs and adapts this to the {@link Scorer} interface.
 */
import { Evaluation, OptimizeTarget, Scorer } from 'src/app/optimizer/types';

/** Player-side combat stats needed for the estimate (already realm/modifier-resolved). */
export interface CombatStats {
    /** Maximum damage of a single hit (raw HP points, NOT normalized). */
    maxHit: number;
    /** Minimum damage of a single hit. Melvor hits roll uniformly in [minHit, maxHit]. */
    minHit: number;
    /** Player's accuracy rating (offensive roll, the "attack" side of the accuracy ratio). */
    accuracy: number;
    /** Time between attacks, in milliseconds (e.g. 2400 for a 2.4s weapon). */
    attackInterval: number;
}

/** Target-side stats needed for the estimate. */
export interface TargetStats {
    /** Target effective hitpoints (raw HP points). */
    hitpoints: number;
    /** Target's evasion rating (defensive roll, the "defence" side of the accuracy ratio). */
    evasion: number;
}

/** Which objective the surrogate estimates. */
export type AnalyticMetric = 'kills' | 'xp';

/**
 * Hit chance from an accuracy-vs-evasion ratio.
 *
 * APPROXIMATION — classic RuneScape / Melvor "two-roll" accuracy. Melvor's exact formula is
 * piecewise:
 *     if accuracy < evasion:  chance = (0.5 * accuracy) / evasion
 *     else:                   chance = 1 - (0.5 * evasion) / accuracy
 * which is continuous at accuracy == evasion (chance = 0.5), strictly increasing in accuracy,
 * strictly decreasing in evasion, and bounded in (0, 1). We reproduce that shape here. It is a
 * surrogate: the real sim also folds in special attacks, status effects, etc., which we ignore.
 *
 * @returns hit chance in the open interval (0, 1).
 */
export function hitChance(accuracy: number, evasion: number): number {
    const acc = Math.max(0, accuracy);
    const eva = Math.max(0, evasion);
    // Degenerate guards so the ratio stays finite and bounded.
    if (acc <= 0) {
        return 0;
    }
    if (eva <= 0) {
        return 1;
    }
    const chance = acc < eva ? (0.5 * acc) / eva : 1 - (0.5 * eva) / acc;
    // Clamp strictly inside (0, 1) to keep downstream products well-behaved.
    return Math.min(1, Math.max(0, chance));
}

/** Average damage of a single (rolled-uniform) hit, BEFORE applying hit chance. */
export function averageHitDamage(player: CombatStats): number {
    const min = Math.max(0, player.minHit);
    const max = Math.max(min, player.maxHit);
    return (min + max) / 2;
}

/**
 * Expected damage dealt per second (DPS).
 *
 * APPROXIMATION:
 *     avgDamagePerHit = hitChance * (min + max) / 2
 *     DPS             = avgDamagePerHit / (attackInterval seconds)
 *
 * Misses contribute zero damage; the attack interval is the per-swing cadence regardless of
 * hit/miss (matches Melvor — you still wait the full interval on a miss).
 */
export function estimateDps(player: CombatStats, target: TargetStats): number {
    const intervalSeconds = Math.max(player.attackInterval, 1) / 1000;
    const avgDamagePerHit = hitChance(player.accuracy, target.evasion) * averageHitDamage(player);
    return avgDamagePerHit / intervalSeconds;
}

/**
 * Estimate the chosen objective metric for the player vs. the target.
 *
 * - `'kills'`: kills per second ~= DPS / target.hitpoints. Monotonic: up in maxHit/minHit and
 *   accuracy, up as attackInterval shrinks, DOWN as the target gets tankier (more hitpoints or
 *   more evasion). (Reported as a per-second rate; the integration layer can scale to per-hour.)
 * - `'xp'`: xp per second ~= proportional to damage dealt per second. In Melvor, combat xp is
 *   driven by damage done, so we use DPS directly as the xp-rate surrogate (a single shared
 *   proportionality constant cancels out for ranking and is left to later calibration). Note xp
 *   does NOT divide by hitpoints, so a tankier-by-evasion target lowers xp/sec (fewer hits land)
 *   but more hitpoints alone does not.
 *
 * APPROXIMATION — absolute magnitudes are not meaningful; only the ordering is, until calibrated.
 */
export function estimateMetric(player: CombatStats, target: TargetStats, metric: AnalyticMetric): number {
    const dps = estimateDps(player, target);
    if (metric === 'xp') {
        return dps;
    }
    // 'kills'
    const hp = Math.max(1, target.hitpoints);
    return dps / hp;
}

/**
 * Adapts {@link estimateMetric} to the {@link Scorer} interface shape.
 *
 * Unlike `GameScorer`, the analytic surrogate cannot read the live world from a `(target,
 * trials, ticks)` call alone — it needs the resolved {@link CombatStats}/{@link TargetStats}.
 * The integration layer is therefore responsible for (re)computing those stats for the
 * currently-applied loadout and handing them to this scorer before each `evaluate`. We expose
 * two ways to feed it:
 *
 *   1. `setStats(player, target)` — push the freshly-derived stats, then call `evaluate`.
 *   2. `statsProvider` constructor arg — a pull callback invoked lazily inside `evaluate`.
 *
 * `trials` / `ticks` are ignored (no Monte-Carlo here); they exist only to satisfy the
 * interface and keep the optimizer's call sites identical between tiers. `deathRate` is left
 * at 0 — survivability is out of scope for the Tier-1 surrogate and must be enforced by the
 * real sim before any loadout is accepted.
 */
export class AnalyticScorer implements Scorer {
    private player?: CombatStats;
    private target?: TargetStats;

    constructor(
        private readonly metric: AnalyticMetric,
        private readonly statsProvider?: () => { player: CombatStats; target: TargetStats }
    ) {}

    /** Push the resolved stats for the currently-applied loadout (option 1). */
    public setStats(player: CombatStats, target: TargetStats): void {
        this.player = player;
        this.target = target;
    }

    public async evaluate(_target: OptimizeTarget, _trials: number, _ticks: number): Promise<Evaluation> {
        const stats = this.resolveStats();
        if (!stats) {
            return { metric: NaN, deathRate: 0, success: false };
        }
        const value = estimateMetric(stats.player, stats.target, this.metric);
        return { metric: value, deathRate: 0, success: Number.isFinite(value) };
    }

    /** Both objectives the surrogate supports are maximized (kills/sec, xp/sec). */
    public isMaximize(): boolean {
        return true;
    }

    private resolveStats(): { player: CombatStats; target: TargetStats } | undefined {
        if (this.statsProvider) {
            return this.statsProvider();
        }
        if (this.player && this.target) {
            return { player: this.player, target: this.target };
        }
        return undefined;
    }
}
