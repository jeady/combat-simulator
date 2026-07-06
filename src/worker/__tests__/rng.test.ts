import { describe, expect, it } from 'vitest';
import { installSeededRandom, mixSeed, mulberry32 } from 'src/worker/rng';

describe('mulberry32', () => {
    it('is deterministic for a fixed seed', () => {
        const a = mulberry32(12345);
        const b = mulberry32(12345);
        const seqA = Array.from({ length: 8 }, () => a());
        const seqB = Array.from({ length: 8 }, () => b());
        expect(seqA).toEqual(seqB);
    });

    it('produces different streams for different seeds', () => {
        const a = Array.from({ length: 8 }, mulberry32(1));
        const b = Array.from({ length: 8 }, mulberry32(2));
        expect(a).not.toEqual(b);
    });

    it('returns floats in [0, 1)', () => {
        const rng = mulberry32(99);
        for (let i = 0; i < 1000; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe('mixSeed', () => {
    it('is deterministic', () => {
        expect(mixSeed(7, 3)).toBe(mixSeed(7, 3));
    });

    it('decorrelates adjacent indices (consecutive indices give distinct 32-bit seeds)', () => {
        const seeds = new Set<number>();
        for (let i = 0; i < 64; i++) {
            seeds.add(mixSeed(42, i));
        }
        // No collisions across 64 consecutive indices, and the resulting streams differ.
        expect(seeds.size).toBe(64);
        expect(mulberry32(mixSeed(42, 0))()).not.toBe(mulberry32(mixSeed(42, 1))());
    });

    it('returns an unsigned 32-bit integer', () => {
        const s = mixSeed(0xffffffff, 123456);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(0xffffffff);
    });
});

describe('installSeededRandom', () => {
    it('is a no-op for undefined/null (never touches Math.random)', () => {
        const original = Math.random;
        expect(installSeededRandom(undefined)).toBeNull();
        expect(installSeededRandom(null)).toBeNull();
        expect(Math.random).toBe(original);
    });

    it('makes Math.random deterministic, then restore() reinstalls the exact original', () => {
        const original = Math.random;
        const restore = installSeededRandom(2024);
        expect(restore).not.toBeNull();
        expect(Math.random).not.toBe(original);

        // Same seed reproduces the same global draws.
        const draws1 = Array.from({ length: 5 }, () => Math.random());
        restore!();
        expect(Math.random).toBe(original);

        const restore2 = installSeededRandom(2024);
        const draws2 = Array.from({ length: 5 }, () => Math.random());
        restore2!();
        expect(draws1).toEqual(draws2);
        expect(Math.random).toBe(original);
    });

    it('different seeds give different global draws', () => {
        const original = Math.random;
        const r1 = installSeededRandom(1);
        const a = Array.from({ length: 5 }, () => Math.random());
        r1!();
        const r2 = installSeededRandom(2);
        const b = Array.from({ length: 5 }, () => Math.random());
        r2!();
        expect(a).not.toEqual(b);
        expect(Math.random).toBe(original);
    });
});
