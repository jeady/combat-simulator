import { BaseStore } from './_base.store';
import { OptimizeProgress, OptimizeResult } from 'src/app/optimizer/types';
import { AttackTypeConstraint } from 'src/app/optimizer/weapon-rules';

export interface OptimizerState {
    isRunning: boolean;
    /** Trials used per candidate during the search (kept low for speed). */
    searchTrials: number;
    /** Ticks used per candidate during the search. */
    searchTicks: number;
    /**
     * Adaptive trials (§2e): screen a slot's candidates at a low trial count, then confirm only the
     * best few at full `searchTrials`. Clear losers are dropped after a cheap screen instead of paying
     * a full evaluation each — a large sim-time saving on slots (and the new spell dimensions) with
     * many candidates. On by default; turn off for an exhaustive full-trial pass over every candidate.
     */
    fastSearch: boolean;
    /**
     * Analytic pre-rank (§2b): keep only the top-K candidates per equipment slot by the cheap
     * closed-form surrogate before spending real sims. 0 disables it (the default) — it's a heuristic
     * that can, if K is too small, drop the true best item, so it's opt-in and independent of
     * {@link fastSearch} (which narrows with real low-trial sims and is safer).
     */
    preRankTopK: number;
    /**
     * How many parallel sim workers to run (§2d). The base mod uses a single worker; a pool of N
     * evaluates up to N candidate loadouts at once, cutting wall-clock roughly N×. 0 = auto (pick a
     * modest count from the CPU); 1 = the classic single-worker path. Each worker loads its own copy
     * of the game data, so higher counts cost more memory + a one-time startup.
     */
    workerCount: number;
    /**
     * Constrain the weapon search to an attack type. `current` (default) keeps the search on the
     * character's configured attack type — so optimizing a magic build won't recommend a melee weapon
     * — while `any` searches across all types. Also gates the Quiver slot (ammo only matters to a
     * ranged weapon). One of: 'current' | 'any' | 'melee' | 'ranged' | 'magic'.
     */
    attackTypeConstraint: AttackTypeConstraint;
    progress?: OptimizeProgress;
    result?: OptimizeResult;
}

export class OptimizerStore extends BaseStore<OptimizerState> {
    constructor() {
        super({
            isRunning: false,
            searchTrials: 200,
            searchTicks: 1000,
            fastSearch: true,
            preRankTopK: 0,
            workerCount: 0,
            attackTypeConstraint: 'current'
        });
    }
}
