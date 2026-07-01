import { Global } from './global';

export class Simulator {
    /** Simulation Method for a single monster (single result — unchanged public API). */
    public async simulateMonster(
        saveString: string,
        monsterId: string,
        entityId: string,
        trials: number,
        maxTicks: number,
        deathAbortThreshold?: number
    ) {
        const { result } = await this.runBatches(saveString, monsterId, entityId, trials, maxTicks, deathAbortThreshold, 1);
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
        batches: number
    ) {
        return this.runBatches(saveString, monsterId, entityId, trials, maxTicks, deathAbortThreshold, batches);
    }

    /**
     * Decode the save once, then run `batches` (≥1) independent trial runs and convert each to a
     * result. `runTrials` calls `resetSimStats()` (which processes death, resets gains, and restores
     * full HP) at the start of every run, so each batch begins from the same fresh state the fight
     * loop already relies on between trials — no re-decode needed. Returns the first batch as `result`
     * (a representative single result) plus every batch in `batchResults` when there is more than one.
     */
    private async runBatches(
        saveString: string,
        monsterId: string,
        entityId: string,
        trials: number,
        maxTicks: number,
        deathAbortThreshold: number | undefined,
        batches: number
    ): Promise<{ result: any; batchResults?: any[] }> {
        try {
            Global.cancelStatus = false;

            const reader = new SaveWriter('Read', 1);
            const saveVersion = reader.setDataFromSaveString(saveString);

            Global.game.decodeSimple(reader, saveVersion);
            Global.game.onLoad();
            Global.game.combat.player.initForWebWorker();

            const b = Math.max(1, Math.floor(batches) || 1);
            if (b <= 1) {
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
                const stats = await Global.game.combat.runTrials(monsterId, entityId, perBatch, maxTicks, false, deathAbortThreshold);
                batchResults.push(Global.game.combat.convertSlowSimToResult(stats, perBatch));
            }

            // If cancelled before any batch completed, fall through to a single run so the caller still
            // gets a well-formed (failed) result rather than an empty batch list.
            if (batchResults.length === 0) {
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
