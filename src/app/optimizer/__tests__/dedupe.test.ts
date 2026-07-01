import { describe, expect, it } from 'vitest';
import { dedupeBySignature } from 'src/app/optimizer/dedupe';

describe('dedupeBySignature', () => {
    it('keeps the first item of each signature, preserving order', () => {
        const items = [
            { id: 'shrimp', heal: 10, buff: false },
            { id: 'sardine', heal: 10, buff: false }, // same signature as shrimp => dropped
            { id: 'lobster', heal: 40, buff: false },
            { id: 'trout', heal: 40, buff: false } // same as lobster => dropped
        ];
        const sig = (f: (typeof items)[number]) => (f.buff ? `id:${f.id}` : `heal:${f.heal}`);
        expect(dedupeBySignature(items, sig).map(f => f.id)).toEqual(['shrimp', 'lobster']);
    });

    it('never merges items given distinct signatures (buffed items stay unique)', () => {
        const items = [
            { id: 'a', heal: 10, buff: true },
            { id: 'b', heal: 10, buff: true } // same heal, but buffed => distinct signature => kept
        ];
        const sig = (f: (typeof items)[number]) => (f.buff ? `id:${f.id}` : `heal:${f.heal}`);
        expect(dedupeBySignature(items, sig).map(f => f.id)).toEqual(['a', 'b']);
    });

    it('returns an empty array unchanged', () => {
        expect(dedupeBySignature([], () => 'x')).toEqual([]);
    });

    it('keeps a single item', () => {
        expect(dedupeBySignature([{ id: 'x' }], i => i.id)).toEqual([{ id: 'x' }]);
    });
});
