/**
 * Parallel worker pool (P2 §2d).
 *
 * The base mod owns a single web worker, so candidate simulations run strictly serially. A pool of N
 * workers evaluates up to N candidates at once. This wraps N simulator instances and dispatches a
 * batch of simulate requests across them with {@link parallelMap} (which bounds in-flight work to the
 * pool size), returning results in request order.
 *
 * Testability: the pool depends only on the small {@link SimulatorLike} interface, so its dispatch /
 * worker-assignment logic is unit-tested headless with fakes. The real `Simulator` — which spins up
 * an actual `Worker` and can't run under Node/vitest — is injected via `createWorkerPool` in the
 * separate `worker-pool-factory.ts` (kept apart so this module imports no browser globals).
 *
 * IN-GAME VERIFICATION REQUIRED: the N-worker *speedup* and the correctness of running N real Workers
 * concurrently can only be confirmed in the running game (there is no browser `Worker` in the headless
 * harness, which simulates in-process). This module deliberately does NOT alter the existing
 * single-worker path — it's an additive alternative the optimizer/UI can opt into.
 */
import { SimulateRequest, SimulateResponse } from 'src/shared/transport/type/simulate';
import { parallelMap } from 'src/app/optimizer/parallel';

/** Per-request outcome from {@link WorkerPool.simulateManySettled}: a value, or the error that request threw. */
export type SettledResponse =
    | { ok: true; value: SimulateResponse }
    | { ok: false; error: unknown };

/** The slice of {@link Simulator} the pool needs — kept minimal so fakes can stand in under test. */
export interface SimulatorLike {
    init(): Promise<unknown>;
    simulate(request: SimulateRequest): Promise<SimulateResponse>;
    cancel(): Promise<unknown> | unknown;
    /** Optional teardown — real pooled workers implement it so the pool can free their threads. */
    terminate?(): void;
}

export class WorkerPool {
    /** Idle simulators available to claim. With ≤ size requests in flight it never underflows. */
    private readonly available: SimulatorLike[];

    constructor(private readonly simulators: SimulatorLike[]) {
        if (simulators.length === 0) {
            throw new Error('WorkerPool requires at least one simulator');
        }
        this.available = [...simulators];
    }

    public get size(): number {
        return this.simulators.length;
    }

    /** Initialise every worker (loads game data into each). One-time, N× the single-worker cost. */
    public async init(): Promise<void> {
        await Promise.all(this.simulators.map(sim => sim.init()));
    }

    /** Run one request on any free worker. */
    public async simulate(request: SimulateRequest): Promise<SimulateResponse> {
        const [result] = await this.simulateMany([request]);
        return result;
    }

    /**
     * Run a batch of requests across the pool, ≤ `size` at a time, results in request order. Each
     * task claims an idle simulator for its duration and returns it afterward; because
     * {@link parallelMap} caps in-flight tasks at the pool size, a free simulator is always available.
     */
    public simulateMany(requests: readonly SimulateRequest[]): Promise<SimulateResponse[]> {
        return parallelMap(requests, this.simulators.length, async request => {
            const sim = this.available.pop();
            if (!sim) {
                // Unreachable: parallelMap bounds concurrency to the pool size. Guard anyway.
                throw new Error('WorkerPool: no idle simulator (concurrency invariant violated)');
            }
            try {
                return await sim.simulate(request);
            } finally {
                this.available.push(sim);
            }
        });
    }

    /**
     * Like {@link simulateMany}, but each request's outcome is captured independently: one request's
     * failure does NOT reject the whole batch (as `parallelMap` / `Promise.all` would). Results are in
     * request order; every task returns its simulator to the pool in a `finally`, so a failed request
     * never leaks a worker or underflows the pool. Callers map `ok:false` entries to their own failure
     * value (e.g. a NaN evaluation) so a single bad worker request doesn't nuke a whole dimension's batch.
     */
    public simulateManySettled(requests: readonly SimulateRequest[]): Promise<SettledResponse[]> {
        return parallelMap(requests, this.simulators.length, async request => {
            const sim = this.available.pop();
            if (!sim) {
                // Unreachable: parallelMap bounds concurrency to the pool size. Guard anyway.
                throw new Error('WorkerPool: no idle simulator (concurrency invariant violated)');
            }
            try {
                return { ok: true, value: await sim.simulate(request) } as SettledResponse;
            } catch (error) {
                return { ok: false, error } as SettledResponse;
            } finally {
                this.available.push(sim);
            }
        });
    }

    /** Cancel any in-progress simulation on every worker. */
    public async cancel(): Promise<void> {
        await Promise.all(this.simulators.map(sim => sim.cancel()));
    }

    /** Tear down every worker in the pool (frees their threads + loaded game data). */
    public terminate(): void {
        for (const sim of this.simulators) {
            sim.terminate?.();
        }
    }
}
