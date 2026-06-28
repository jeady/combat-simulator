import { BaseStore } from './_base.store';
import { OptimizeProgress, OptimizeResult } from 'src/app/optimizer/types';

export interface OptimizerState {
    isRunning: boolean;
    /** Trials used per candidate during the search (kept low for speed). */
    searchTrials: number;
    /** Ticks used per candidate during the search. */
    searchTicks: number;
    progress?: OptimizeProgress;
    result?: OptimizeResult;
}

export class OptimizerStore extends BaseStore<OptimizerState> {
    constructor() {
        super({ isRunning: false, searchTrials: 200, searchTicks: 1000 });
    }
}
