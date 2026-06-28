/**
 * Headless harness entry — bundled by esbuild as a classic IIFE and evaluated in the SAME
 * scope as the (already-loaded) game scripts, so `SimGame extends Game` resolves Game from
 * the shared scope. It reuses the real worker boot (WorkerMock + Environment.init) and the
 * real Simulator, and exposes them on globalThis for the Node runner to drive.
 */
import { Global as GlobalManager } from 'src/shared/global';
import { Global } from 'src/worker/global';
import { WorkerMock } from 'src/worker/context/mock';
import { Environment } from 'src/worker/context/environment';

(globalThis as any).__harness = {
    get global() {
        return Global;
    },
    /** Runs the real worker init: WorkerMock + Environment.init (loads game data, builds SimGame). */
    async init(data: any) {
        GlobalManager.setWorker(Global);
        WorkerMock.init();
        await Environment.init(data);
        return true;
    },
    /** One real simulation, via the real worker Simulator. */
    simulate(saveString: string, monsterId: string, entityId: string | undefined, trials: number, maxTicks: number) {
        return (Global as any).simulator.simulateMonster(saveString, monsterId, entityId, trials, maxTicks);
    }
};
