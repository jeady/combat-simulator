import { describe, expect, it } from 'vitest';
import { pruneDominated, relevantStatKeysForStyle, StatVector } from 'src/app/optimizer/prune';

const KEYS = ['attack', 'strength', 'defence'];

function ids(items: StatVector[]): string[] {
    return items.map(item => item.id).sort();
}

describe('pruneDominated', () => {
    it('removes a strictly dominated item', () => {
        const better: StatVector = { id: 'better', stats: { attack: 10, strength: 10, defence: 10 } };
        const worse: StatVector = { id: 'worse', stats: { attack: 5, strength: 5, defence: 5 } };

        const result = pruneDominated([better, worse], KEYS);

        expect(ids(result)).toEqual(['better']);
    });

    it('always keeps the best item', () => {
        const best: StatVector = { id: 'best', stats: { attack: 20, strength: 20, defence: 20 } };
        const items = [
            best,
            { id: 'mid', stats: { attack: 10, strength: 10, defence: 10 } },
            { id: 'low', stats: { attack: 1, strength: 1, defence: 1 } }
        ];

        const result = pruneDominated(items, KEYS);

        expect(ids(result)).toEqual(['best']);
    });

    it('keeps both items when their vectors are equal (neither strictly dominates)', () => {
        const a: StatVector = { id: 'a', stats: { attack: 7, strength: 7, defence: 7 } };
        const b: StatVector = { id: 'b', stats: { attack: 7, strength: 7, defence: 7 } };

        const result = pruneDominated([a, b], KEYS);

        expect(ids(result)).toEqual(['a', 'b']);
    });

    it('keeps trade-off items on the Pareto frontier (better in one stat, worse in another)', () => {
        const attacker: StatVector = { id: 'attacker', stats: { attack: 10, strength: 2, defence: 0 } };
        const defender: StatVector = { id: 'defender', stats: { attack: 2, strength: 10, defence: 0 } };

        const result = pruneDominated([attacker, defender], KEYS);

        expect(ids(result)).toEqual(['attacker', 'defender']);
    });

    it('treats missing stat keys as 0', () => {
        // `full` has every key; `partial` omits defence, which defaults to 0 — but is otherwise
        // strictly better on attack, so it is NOT dominated and must be kept.
        const full: StatVector = { id: 'full', stats: { attack: 5, strength: 5, defence: 5 } };
        const partial: StatVector = { id: 'partial', stats: { attack: 9, strength: 5 } };

        const result = pruneDominated([full, partial], KEYS);

        expect(ids(result)).toEqual(['full', 'partial']);
    });

    it('drops an item that is dominated once a missing key defaults to 0', () => {
        const full: StatVector = { id: 'full', stats: { attack: 5, strength: 5, defence: 5 } };
        // `partial` ties on attack/strength and has defence default to 0 < 5 -> strictly dominated.
        const partial: StatVector = { id: 'partial', stats: { attack: 5, strength: 5 } };

        const result = pruneDominated([full, partial], KEYS);

        expect(ids(result)).toEqual(['full']);
    });

    it('returns empty output for empty input', () => {
        expect(pruneDominated([], KEYS)).toEqual([]);
    });

    it('keeps everything when there are no relevant keys to compare on', () => {
        const items = [
            { id: 'a', stats: { attack: 1 } },
            { id: 'b', stats: { attack: 9 } }
        ];

        expect(ids(pruneDominated(items, []))).toEqual(['a', 'b']);
    });
});

describe('relevantStatKeysForStyle', () => {
    it('includes style-specific offensive keys', () => {
        expect(relevantStatKeysForStyle('melee')).toContain('meleeStrengthBonus');
        expect(relevantStatKeysForStyle('ranged')).toContain('rangedStrengthBonus');
        expect(relevantStatKeysForStyle('magic')).toContain('magicDamageBonus');
    });

    it('does not leak another style\'s offensive keys', () => {
        const melee = relevantStatKeysForStyle('melee');
        expect(melee).not.toContain('rangedStrengthBonus');
        expect(melee).not.toContain('magicDamageBonus');
    });

    it('shares defensive keys across styles', () => {
        for (const style of ['melee', 'ranged', 'magic'] as const) {
            expect(relevantStatKeysForStyle(style)).toContain('resistance');
        }
    });
});
