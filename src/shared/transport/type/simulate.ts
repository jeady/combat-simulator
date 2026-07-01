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
    /**
     * Split `trials` into this many independent sub-runs within a SINGLE worker call, returning one
     * {@link SimulateResponse.batchResults} entry per sub-run. The optimizer uses these batch means
     * to estimate the metric's standard error for its significance gate — the same thing the app-side
     * `BatchingScorer` did with B separate `simulate()` calls, but now the expensive save decode +
     * `onLoad` is paid once instead of B times. Omitted/≤1 => a single run, `batchResults` unset
     * (unchanged behavior for the normal Simulate page).
     */
    batches?: number;
}

export interface SimulateResponse {
    monsterId: string;
    entityId: string;
    result: SimulationResult | Result;
    /**
     * Per-batch sub-results when {@link SimulateRequest.batches} > 1 (one entry per sub-run over the
     * same setup). Absent for a normal single run. `result` is the first batch (a representative), so
     * existing single-result consumers keep working; variance-aware callers read every batch here.
     */
    batchResults?: (SimulationResult | Result)[];
    time: number;
}

export interface Result {
    simSuccess: boolean;
    reason: string;
    stack?: string;
}
