import { Global } from './global';
import { installSeededRandom, mixSeed } from './rng';

export class Simulator {
    /** Simulation Method for a single monster (single result — unchanged public API). */
    public async simulateMonster(
        saveString: string,
        monsterId: string,
        entityId: string,
        trials: number,
        maxTicks: number,
        deathAbortThreshold?: number,
        rngSeed?: number
    ) {
        const { result } = await this.runBatches(saveString, monsterId, entityId, trials, maxTicks, deathAbortThreshold, 1, rngSeed);
        return result;
    }

    /**
     * Like {@link simulateMonster} but splits `trials` into `batches` independent sub-runs off a
     * SINGLE save decode, returning the per-batch results so the caller can estimate variance. The
     * expensive setup (decode + `onLoad` + `initForWebWorker`) is paid once instead of once per batch.
     */
    public async simulateMonsterBatched(
        saveString: string,
        monsterId: string,
        entityId: string,
        trials: number,
        maxTicks: number,
        deathAbortThreshold: number | undefined,
        batches: number,
        rngSeed?: number
    ) {
        return this.runBatches(saveString, monsterId, entityId, trials, maxTicks, deathAbortThreshold, batches, rngSeed);
    }

    /**
     * Decode the save once, then run `batches` (≥1) independent trial runs and convert each to a
     * result. `runTrials` calls `resetSimStats()` (which processes death, resets gains, and restores
     * full HP) at the start of every run, so each batch begins from the same fresh state the fight
     * loop already relies on between trials — no re-decode needed. Returns the first batch as `result`
     * (a representative single result) plus every batch in `batchResults` when there is more than one.
     *
     * `rngSeed` (roadmap R3): when set, a seeded `mulberry32` is installed as the global `Math.random`
     * around the whole batch loop and restored in `finally`, so the same seed reproduces the same
     * combat rolls (common random numbers). Each batch is re-seeded as `mixSeed(rngSeed, batchIndex)`,
     * which aligns batch j across candidates (the granularity the batch-means gate operates at) while
     * keeping the batches within one run independent of each other. Omitted => `Math.random` is never
     * touched, so behavior is byte-identical to before. See `docs/auto-optimize-crn.md`.
     */
    private async runBatches(
        saveString: string,
        monsterId: string,
        entityId: string,
        trials: number,
        maxTicks: number,
        deathAbortThreshold: number | undefined,
        batches: number,
        rngSeed?: number
    ): Promise<{ result: any; batchResults?: any[] }> {
        // Install the seeded PRNG for the whole request; null when no seed (never touches Math.random).
        // Paired in a finally so a throw still restores the real Math.random and cannot leak the seeded
        // stream into a later request on this worker.
        const seeded = rngSeed !== undefined;
        let restoreRandom = installSeededRandom(rngSeed);
        // Re-seed Math.random to a fresh, batch-aligned stream before each run (no-op when unseeded).
        const reseed = (batchIndex: number) => {
            if (!seeded) {
                return;
            }
            restoreRandom?.();
            restoreRandom = installSeededRandom(mixSeed(rngSeed as number, batchIndex));
        };

        try {
            Global.cancelStatus = false;

            const reader = new SaveWriter('Read', 1);
            const saveVersion = reader.setDataFromSaveString(saveString);

            Global.game.decodeSimple(reader, saveVersion);
            Global.game.onLoad();
            Global.game.combat.player.initForWebWorker();

            const b = Math.max(1, Math.floor(batches) || 1);
            if (b <= 1) {
                reseed(0);
                const stats = await Global.game.combat.runTrials(monsterId, entityId, trials, maxTicks, false, deathAbortThreshold);
                return { result: Global.game.combat.convertSlowSimToResult(stats, trials) };
            }

            // Divide the trials across the batches (ceil so the total is never short of `trials`).
            const perBatch = Math.ceil(trials / b);
            const batchResults: any[] = [];
            for (let i = 0; i < b; i++) {
                if (Global.cancelStatus) {
                    break;
                }
                reseed(i);
                const stats = await Global.game.combat.runTrials(monsterId, entityId, perBatch, maxTicks, false, deathAbortThreshold);
                batchResults.push(Global.game.combat.convertSlowSimToResult(stats, perBatch));
            }

            // If cancelled before any batch completed, fall through to a single run so the caller still
            // gets a well-formed (failed) result rather than an empty batch list.
            if (batchResults.length === 0) {
                reseed(0);
                const stats = await Global.game.combat.runTrials(monsterId, entityId, trials, maxTicks, false, deathAbortThreshold);
                return { result: Global.game.combat.convertSlowSimToResult(stats, trials) };
            }

            return { result: batchResults[0], batchResults };
        } catch (error) {
            Global.logger.error(`Error while simulating monster ${monsterId} in area ${entityId}: ${error.stack}`);
            let reason = 'simulation error';

            if (error instanceof Error) {
                reason += `: ${error.message}`;
            }

            return {
                result: {
                    simSuccess: false,
                    reason,
                    stack: error.stack
                }
            };
        } finally {
            // Always restore the real Math.random (no-op when unseeded — restoreRandom is null).
            restoreRandom?.();
        }
    }

    /** Checks if the simulation has been messaged to be cancelled */
    public isCanceled() {
        return new Promise(resolve => setTimeout(() => resolve(Global.cancelStatus)));
    }

    public cancelSimulation() {
        Global.cancelStatus = true;
    }
}
