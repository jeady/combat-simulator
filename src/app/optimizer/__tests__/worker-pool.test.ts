import { describe, expect, it } from 'vitest';
import { SimulatorLike, WorkerPool } from 'src/app/optimizer/worker-pool';
import { SimulateRequest, SimulateResponse } from 'src/shared/transport/type/simulate';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const req = (monsterId: string): SimulateRequest => ({
    saveString: 's',
    monsterId,
    entityId: undefined as unknown as string,
    trials: 1,
    maxTicks: 1
});

/** A fake worker that records its calls and reports concurrency via a shared counter. */
class FakeSimulator implements SimulatorLike {
    public inits = 0;
    public handled: string[] = [];
    constructor(private readonly shared: { active: number; peak: number }) {}
    async init() {
        this.inits++;
        return true;
    }
    async simulate(request: SimulateRequest): Promise<SimulateResponse> {
        this.shared.active++;
        this.shared.peak = Math.max(this.shared.peak, this.shared.active);
        await tick();
        this.shared.active--;
        this.handled.push(request.monsterId);
        return { monsterId: request.monsterId, entityId: request.entityId, result: { done: true } as any, time: 1 };
    }
    async cancel() {
        return true;
    }
}

describe('WorkerPool', () => {
    it('inits every worker', async () => {
        const shared = { active: 0, peak: 0 };
        const sims = [new FakeSimulator(shared), new FakeSimulator(shared)];
        const pool = new WorkerPool(sims);
        await pool.init();
        expect(sims.every(s => s.inits === 1)).toBe(true);
        expect(pool.size).toBe(2);
    });

    it('runs a batch across workers, results in request order', async () => {
        const shared = { active: 0, peak: 0 };
        const pool = new WorkerPool([new FakeSimulator(shared), new FakeSimulator(shared), new FakeSimulator(shared)]);
        const results = await pool.simulateMany(['a', 'b', 'c', 'd', 'e'].map(req));
        expect(results.map(r => r.monsterId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('never runs more concurrently than the pool size', async () => {
        const shared = { active: 0, peak: 0 };
        const pool = new WorkerPool([new FakeSimulator(shared), new FakeSimulator(shared), new FakeSimulator(shared)]);
        await pool.simulateMany(Array.from({ length: 12 }, (_, i) => req(`m${i}`)));
        expect(shared.peak).toBe(3); // saturates the 3 workers, never exceeds
    });

    it('spreads work across all workers (none left idle under load)', async () => {
        const shared = { active: 0, peak: 0 };
        const sims = [new FakeSimulator(shared), new FakeSimulator(shared), new FakeSimulator(shared)];
        const pool = new WorkerPool(sims);
        await pool.simulateMany(Array.from({ length: 12 }, (_, i) => req(`m${i}`)));
        // Every worker handled at least one task, and all 12 were handled exactly once total.
        expect(sims.every(s => s.handled.length > 0)).toBe(true);
        expect(sims.reduce((sum, s) => sum + s.handled.length, 0)).toBe(12);
    });

    it('simulate() routes a single request through the pool', async () => {
        const shared = { active: 0, peak: 0 };
        const pool = new WorkerPool([new FakeSimulator(shared)]);
        const res = await pool.simulate(req('cow'));
        expect(res.monsterId).toBe('cow');
    });

    it('throws when constructed with no workers', () => {
        expect(() => new WorkerPool([])).toThrow();
    });
});
