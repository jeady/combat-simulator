/**
 * Seeded worker RNG for common random numbers (CRN) — roadmap R3.
 *
 * The game draws ALL combat randomness through the global `Math.random()` at the call site
 * (rollPercentage / rollInteger / generateGaussianNumber / the one direct special-attack roll —
 * none of them cache a reference to the function). So installing a seeded `Math.random` on the
 * worker global for the duration of one simulate request redirects every combat draw to a
 * reproducible stream, with no upstream game-code changes. See `docs/auto-optimize-crn.md`.
 *
 * This module is deliberately tiny and PURE (no game/Global imports) so it is unit-testable
 * headless. `installSeededRandom(undefined)` is a no-op, so the normal Simulate page — which
 * never sets a seed — keeps its exact current behavior (real `Math.random`).
 */

/**
 * mulberry32 — a tiny, fast, well-distributed seeded PRNG returning floats in [0, 1). This is the
 * project's existing PRNG choice (identical to the one in `auto-optimize.ts` and the optimizer
 * tests), reused here so seeded worker sims match the same reproducible-RNG style.
 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Avalanche a (baseSeed, index) pair into a well-distributed 32-bit seed so consecutive indices
 * (e.g. per-batch or per-trial re-seeds) get decorrelated streams rather than adjacent ones. The
 * golden-ratio odd constant spreads the index bits before the two integer-hash mix rounds.
 */
export function mixSeed(baseSeed: number, index: number): number {
    let h = (baseSeed ^ Math.imul(index, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Install a seeded PRNG as the global `Math.random` and return a `restore` closure that puts the
 * original function back — or return `null` when `seed` is undefined/null, so the caller skips
 * restore entirely and the absent-seed path never even touches `Math.random` (byte-identical to
 * today's Simulate page behavior).
 *
 * Usage MUST pair the returned closure in a `finally` so a throw still restores the real
 * `Math.random` and cannot leak the seeded stream into a later request on the same worker.
 */
export function installSeededRandom(seed: number | undefined | null): (() => void) | null {
    if (seed === undefined || seed === null) {
        return null;
    }

    const original = Math.random;
    const rng = mulberry32(seed >>> 0);
    Math.random = rng;

    return () => {
        Math.random = original;
    };
}
