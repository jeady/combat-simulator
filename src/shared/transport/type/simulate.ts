import { SimulationResult } from 'src/shared/simulator/sim-manager';

export interface SimulateRequest {
    saveString: string;
    monsterId: string;
    entityId: string;
    trials: number;
    maxTicks: number;
    /**
     * Abort a trial run early once this many deaths have occurred, returning a partial result.
     * Used by the auto-optimizer: a setup that dies more than the feasibility tolerance allows is
     * already infeasible, so finishing the remaining trials is wasted work. Omitted/undefined =>
     * no early abort (the default for the normal Simulate page), so behavior is unchanged.
     */
    deathAbortThreshold?: number;
}

export interface SimulateResponse {
    monsterId: string;
    entityId: string;
    result: SimulationResult | Result;
    time: number;
}

export interface Result {
    simSuccess: boolean;
    reason: string;
    stack?: string;
}
