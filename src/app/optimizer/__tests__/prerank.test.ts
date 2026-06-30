import { describe, expect, it } from 'vitest';
import { PreRankingCandidateProvider, ScoredCandidate, selectTopK } from 'src/app/optimizer/prerank';
import { CandidateProvider } from 'src/app/optimizer/types';

const scored = (...pairs: [string, number][]): ScoredCandidate[] => pairs.map(([id, score]) => ({ id, score }));

describe('selectTopK', () => {
    it('returns the k highest-scoring ids in descending order', () => {
        expect(selectTopK(scored(['a', 1], ['b', 5], ['c', 3], ['d', 2]), 2)).toEqual(['b', 'c']);
    });

    it('returns all candidates (still score-sorted) when k >= candidate count', () => {
        expect(selectTopK(scored(['a', 1], ['b', 2]), 5)).toEqual(['b', 'a']);
    });

    it('k <= 0 disables ranking and preserves input order', () => {
        expect(selectTopK(scored(['a', 1], ['b', 9], ['c', 3]), 0)).toEqual(['a', 'b', 'c']);
    });

    it('breaks ties by input order (stable)', () => {
        expect(selectTopK(scored(['a', 5], ['b', 5], ['c', 5]), 2)).toEqual(['a', 'b']);
    });

    it('sorts NaN scores to the bottom (never promotes an unscorable item)', () => {
        expect(selectTopK(scored(['a', NaN], ['b', 1], ['c', 2]), 2)).toEqual(['c', 'b']);
        expect(selectTopK(scored(['a', NaN], ['b', 1]), 1)).toEqual(['b']);
    });

    it('always retains kept ids even when they fall outside the top-k (appended after winners)', () => {
        const result = selectTopK(scored(['a', 1], ['b', 5], ['c', 3], ['cur', 0.1]), 2, new Set(['cur']));
        expect(result).toEqual(['b', 'c', 'cur']);
    });

    it('does not duplicate a kept id that is already in the top-k', () => {
        const result = selectTopK(scored(['a', 9], ['b', 5], ['c', 3]), 2, new Set(['a']));
        expect(result).toEqual(['a', 'b']);
    });
});

/** A base provider returning a fixed candidate list per slot. */
class FixedProvider implements CandidateProvider {
    constructor(private readonly bySlot: Record<string, string[]>) {}
    public getCandidates(slotId: string): string[] {
        return this.bySlot[slotId] ?? [];
    }
}

describe('PreRankingCandidateProvider', () => {
    // Score = the trailing number in the id (so "w20" scores 20), making expectations obvious.
    const scoreById = (_slot: string, id: string) => Number(id.replace(/\D/g, ''));

    it('narrows a slot to its top-K by surrogate score', () => {
        const base = new FixedProvider({ weapon: ['w10', 'w50', 'w30', 'w20', 'w40'] });
        const provider = new PreRankingCandidateProvider(base, scoreById, 2);

        expect(provider.getCandidates('weapon')).toEqual(['w50', 'w40']);
    });

    it('passes slots with <= K candidates through untouched (no scoring needed)', () => {
        let calls = 0;
        const base = new FixedProvider({ helmet: ['h1', 'h2'] });
        const provider = new PreRankingCandidateProvider(
            base,
            (_s, id) => {
                calls++;
                return Number(id.replace(/\D/g, ''));
            },
            3
        );

        expect(provider.getCandidates('helmet')).toEqual(['h1', 'h2']);
        expect(calls).toBe(0); // short-circuited: no surrogate evaluation
    });

    it('retains the current item even if the surrogate ranks it below the cut', () => {
        const base = new FixedProvider({ weapon: ['w10', 'w50', 'w30', 'w20', 'w40'] });
        const provider = new PreRankingCandidateProvider(base, scoreById, 2, () => 'w10');

        // Top-2 are w50,w40; the equipped w10 is appended so "leave as-is" stays reachable.
        expect(provider.getCandidates('weapon')).toEqual(['w50', 'w40', 'w10']);
    });

    it('k <= 0 disables pre-ranking entirely', () => {
        const base = new FixedProvider({ weapon: ['w10', 'w50', 'w30'] });
        const provider = new PreRankingCandidateProvider(base, scoreById, 0);

        expect(provider.getCandidates('weapon')).toEqual(['w10', 'w50', 'w30']);
    });
});
