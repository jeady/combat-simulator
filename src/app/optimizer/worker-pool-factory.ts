/**
 * Real-worker factory for {@link WorkerPool}, kept in its own module so `worker-pool.ts` stays pure
 * and headless-testable: importing {@link Simulator} pulls in the browser `Worker`/`self` globals,
 * which don't exist under Node/vitest. Only the running game imports this file.
 */
import { Simulator } from 'src/app/worker/simulator';
import { WorkerPool } from 'src/app/optimizer/worker-pool';

/** Build a pool of `size` real workers for the running game. */
export function createWorkerPool(size: number): WorkerPool {
    const count = Math.max(1, Math.floor(size) || 1);
    return new WorkerPool(Array.from({ length: count }, () => new Simulator()));
}
