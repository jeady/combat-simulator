import { BaseStore } from './_base.store';
import { OptimizeProgress, OptimizeResult } from 'src/app/optimizer/types';
import { AttackTypeConstraint } from 'src/app/optimizer/weapon-rules';

/**
 * Which items the equipment search may draw from:
 * - `owned` — only gear the character has ever found (the default, smallest pool).
 * - `craftable` — owned gear PLUS anything the character is a high enough skill level to craft.
 * - `all` — every equippable item in the game.
 */
export type ItemPool = 'owned' | 'craftable' | 'all';

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
     * Constrain the weapon search to an attack type. `current` (default) keeps the search on the
     * character's configured attack type — so optimizing a magic build won't recommend a melee weapon
     * — while `any` searches across all types. Also gates the Quiver slot (ammo only matters to a
     * ranged weapon). One of: 'current' | 'any' | 'melee' | 'ranged' | 'magic'.
     */
    attackTypeConstraint: AttackTypeConstraint;
    /** Which items the equipment search may draw from (owned / owned+craftable / all). */
    itemPool: ItemPool;
    /**
     * When true, a second optimization pass tunes character-progression combat levers — the agility
     * course (obstacles on the target's realm) and the cartography Point of Interest — on top of the
     * best gear, after the main search finishes. Off by default to keep the main run lean. See the
     * staged-pass wiring in the auto-optimize page.
     */
    optimizeProgression: boolean;
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
            attackTypeConstraint: 'current',
            itemPool: 'owned',
            optimizeProgression: false
        });
    }
}
