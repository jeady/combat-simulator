/**
 * Evaluation memoization (P2 §2c).
 *
 * Coordinate ascent re-visits identical setups constantly: on a convergence pass it re-tries a
 * slot's candidates against an unchanged background, and (once restarts land) different starts
 * revisit the same loadouts. Each {@link Scorer.evaluate} is a full worker simulation — the most
 * expensive thing the optimizer does — so caching results keyed by the *applied setup* turns those
 * repeats into free lookups.
 *
 * Implemented as a {@link Scorer} decorator so it needs ZERO changes to the search engine
 * (`optimizer.ts`): the optimizer still just calls `evaluate`, unaware a cache sits in front. The
 * cache reads the current applied setup through an injected `setupKey()` (the only world-specific
 * bit), keeping this module pure and headless-testable.
 *
 * NOTE on determinism: a simulation is stochastic (it samples `trials` random fights), so the cache
 * memoizes ONE sample per (setup, target, trials, ticks, abort) key. That is a deliberate trade:
 * the search treats every metric as an estimate anyway, and serving a stable cached estimate for an
 * identical setup actually removes a source of noise-driven flip-flopping between equal loadouts.
 * The key includes `trials`/`ticks`, so the higher-fidelity final re-score (more trials) never
 * collides with a coarser search-time entry — it always runs a fresh, full simulation.
 */
import { Evaluation, OptimizeTarget, Scorer } from 'src/app/optimizer/types';

/**
 * A deterministic string for any snapshot, including `Map`/`Set` (which `JSON.stringify` otherwise
 * renders as `{}` — collapsing distinct setups into one colliding key). The game's setup snapshot
 * (`SettingsController.export()`) holds several `Map`s (equipment, levels, …), so a plain stringify
 * would make every loadout that differs only in equipment hash identically — serving WRONG cached
 * results. `Map`/`Set` entries are sorted so equal setups always produce byte-identical output
 * regardless of insertion order. Pure (no game deps) → unit-testable.
 */
export function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_key, val) => {
        if (val instanceof Map) {
            return { __map: [...val.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
        }
        if (val instanceof Set) {
            return { __set: [...val].map(String).sort() };
        }
        return val;
    });
}

export class MemoizingScorer implements Scorer {
    private readonly cache = new Map<string, Evaluation>();
    /** Lookups served from cache (a saved simulation). */
    public hits = 0;
    /** Lookups that fell through to a real simulation. */
    public misses = 0;

    constructor(
        private readonly inner: Scorer,
        /**
         * A stable string identifying the setup CURRENTLY applied to the world. Called once per
         * evaluation, after the optimizer has applied its candidate, so it reflects the exact
         * (conflict-resolved) loadout about to be scored. Two setups that sim identically must map
         * to the same string; setups that differ must not collide.
         */
        private readonly setupKey: () => string
    ) {}

    public async evaluate(
        target: OptimizeTarget,
        trials: number,
        ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        const key = this.keyFor(target, trials, ticks, deathAbortThreshold);
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            this.hits++;
            return cached;
        }
        this.misses++;
        const evaluation = await this.inner.evaluate(target, trials, ticks, deathAbortThreshold);
        this.cache.set(key, evaluation);
        return evaluation;
    }

    public isMaximize(): boolean {
        return this.inner.isMaximize();
    }

    /** Number of distinct setups simulated (cache entries). */
    public get size(): number {
        return this.cache.size;
    }

    /** Drop all cached results and reset counters (e.g. when the objective/target changes). */
    public clear(): void {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }

    private keyFor(target: OptimizeTarget, trials: number, ticks: number, deathAbortThreshold?: number): string {
        // Everything that changes the simulated outcome goes into the key. `deathAbortThreshold`
        // matters because an aborted run returns a partial result that must not be served for a
        // full (non-aborting) evaluation of the same setup.
        return [
            this.setupKey(),
            target.monsterId,
            target.entityId ?? '',
            trials,
            ticks,
            deathAbortThreshold ?? ''
        ].join('|');
    }
}
