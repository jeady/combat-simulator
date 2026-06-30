/**
 * Analytic two-tier pre-ranking (P2 §2b) — the pure half.
 *
 * Full-simulating every owned item in a slot is the dominant cost. Most candidates are obviously
 * worse, though, and a cheap closed-form surrogate (see `analytic-scorer.ts`) can rank them without
 * a worker sim. This module turns "full-sim every candidate" into "full-sim only the top-K the
 * surrogate likes" by wrapping the {@link CandidateProvider} the optimizer already consumes:
 *
 *     analytic pre-rank (cheap, this module)  ->  full-sim top-K (the optimizer's real Scorer)
 *
 * It is deliberately PURE (no game / `Global.*` dependency): the per-item analytic score is supplied
 * by an injected `scoreItem` callback, which the game adapter implements by equipping the candidate
 * on the current background, recomputing stats, and reading the surrogate. That keeps the selection
 * logic here unit-testable headless, and isolates the (game-coupled, sim-verified) stat derivation.
 *
 * Soundness note: pre-ranking is a HEURISTIC filter, unlike `prune.ts` (which only ever drops
 * provably-dominated items). The surrogate is an approximation, so a too-small K can drop the true
 * optimum. K is therefore configurable, and the current choice is always retained so the optimizer
 * can still "leave the slot as-is".
 */
import { CandidateProvider } from 'src/app/optimizer/types';

/** A candidate item id paired with its (higher-is-better) surrogate score. */
export interface ScoredCandidate {
    id: string;
    score: number;
}

/**
 * The ids of the `k` highest-scoring candidates (descending), plus any `keep` ids that fell outside
 * the top-k (retained, appended after the winners). `NaN` scores sort to the bottom (a surrogate
 * that couldn't evaluate an item shouldn't promote it). Ties keep input order (stable).
 */
export function selectTopK(scored: ScoredCandidate[], k: number, keep: ReadonlySet<string> = new Set()): string[] {
    if (k <= 0) {
        // Pre-ranking effectively disabled: keep everything (preserve input order).
        return scored.map(s => s.id);
    }
    // Stable sort by score desc; NaN treated as -Infinity so it never wins a slot.
    const ordered = scored
        .map((s, index) => ({ ...s, index }))
        .sort((a, b) => {
            const av = Number.isNaN(a.score) ? -Infinity : a.score;
            const bv = Number.isNaN(b.score) ? -Infinity : b.score;
            return bv - av || a.index - b.index;
        });

    const winners = ordered.slice(0, k);
    const chosen = new Set(winners.map(w => w.id));

    // Re-append any must-keep ids that didn't make the cut, in their original order.
    const kept = scored.filter(s => keep.has(s.id) && !chosen.has(s.id)).map(s => s.id);

    return [...winners.map(w => w.id), ...kept];
}

/**
 * Wraps a {@link CandidateProvider} so each slot yields only its top-K candidates by the injected
 * surrogate score. Slots with `<= k` candidates (or `k <= 0`) pass through untouched — pre-ranking
 * only pays off when there are more candidates than we want to sim.
 *
 * `scoreItem(slotId, itemId)` must score the item AS IF equipped on the current background (so the
 * ranking reflects the rest of the loadout); the game adapter handles the apply/restore. The
 * currently-equipped item for the slot, if provided via `currentItem`, is always retained.
 */
export class PreRankingCandidateProvider implements CandidateProvider {
    constructor(
        private readonly base: CandidateProvider,
        private readonly scoreItem: (slotId: string, itemId: string) => number,
        private readonly k: number,
        private readonly currentItem?: (slotId: string) => string | undefined
    ) {}

    public getCandidates(slotId: string): string[] {
        const ids = this.base.getCandidates(slotId);
        if (this.k <= 0 || ids.length <= this.k) {
            return ids;
        }
        const scored = ids.map(id => ({ id, score: this.scoreItem(slotId, id) }));
        const current = this.currentItem?.(slotId);
        const keep = current ? new Set([current]) : undefined;
        return selectTopK(scored, this.k, keep);
    }
}
