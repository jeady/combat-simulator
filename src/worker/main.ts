import 'src/shared/constants';
import { Global as SharedGlobal } from 'src/shared/global';
import { Global } from './global';
import { MessageAction } from 'src/shared/transport/message';
import { WorkerMock } from './context/mock';
import { Environment } from './context/environment';

export abstract class Main {
    public static async init() {
        SharedGlobal.setWorker(Global);

        Global.transport.on(MessageAction.Init, async data => {
            const duration = await Global.time(async () => {
                WorkerMock.init();
                await Environment.init(data);
            });

            Global.logger.log(`Initialised in ${duration} ms`);
        });

        Global.transport.on(MessageAction.Simulate, async data => {
            const start = performance.now();

            // batches > 1 => one decode, several sub-runs, per-batch results for variance estimation.
            if (data.batches && data.batches > 1) {
                const { result, batchResults } = await Global.simulator.simulateMonsterBatched(
                    data.saveString,
                    data.monsterId,
                    data.entityId,
                    data.trials,
                    data.maxTicks,
                    data.deathAbortThreshold,
                    data.batches
                );

                return { monsterId: data.monsterId, entityId: data.entityId, result, batchResults, time: performance.now() - start };
            }

            const result = await Global.simulator.simulateMonster(
                data.saveString,
                data.monsterId,
                data.entityId,
                data.trials,
                data.maxTicks,
                data.deathAbortThreshold
            );

            return { monsterId: data.monsterId, entityId: data.entityId, result, time: performance.now() - start };
        });

        Global.transport.on(MessageAction.Cancel, async () => Global.simulator.cancelSimulation());
    }
}
