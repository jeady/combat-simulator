/**
 * Bounded-concurrency scheduler (P2 §2d) — the pure, testable core of the worker pool.
 *
 * The base mod runs ONE web worker, so candidate simulations execute strictly one at a time. With a
 * pool of N workers we can evaluate up to N candidates at once — but only if something schedules the
 * work across the workers without exceeding N in flight. That scheduler is this function; it has no
 * dependency on workers or the game, so it's unit-tested headless, and the {@link WorkerPool} (which
 * DOES own real `Worker`s) is a thin wrapper over it.
 *
 * Semantics: runs `fn` over `items` with at most `concurrency` in flight at any moment, and resolves
 * to the results in INPUT order (not completion order). Rejects on the first `fn` rejection, like
 * `Promise.all` (callers that want per-item error capture should make `fn` return a result union).
 */
export async function parallelMap<I, O>(
    items: readonly I[],
    concurrency: number,
    fn: (item: I, index: number) => Promise<O>
): Promise<O[]> {
    const n = items.length;
    const results = new Array<O>(n);
    if (n === 0) {
        return results;
    }
    const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, n));

    // A shared cursor: each runner repeatedly claims the next unclaimed index until they're gone. At
    // most `limit` runners exist, so at most `limit` `fn` calls are ever in flight.
    let next = 0;
    const runner = async (): Promise<void> => {
        while (true) {
            const index = next++;
            if (index >= n) {
                return;
            }
            results[index] = await fn(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: limit }, runner));
    return results;
}
