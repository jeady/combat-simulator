/**
 * Tests for the Tier-1 analytic surrogate scorer. These assert MONOTONICITY and sensible
 * DIRECTIONAL/ordering properties only — never exact magic numbers, since every formula is a
 * deliberate approximation to be calibrated against the real sim later. (Two exceptions: the
 * hit-chance boundary at accuracy == evasion is a defined property of the formula = 0.5, and the
 * 0..1 bounds, so those we do pin.)
 */
import { describe, expect, it } from 'vitest';
import {
    AnalyticScorer,
    CombatStats,
    TargetStats,
    averageHitDamage,
    estimateDps,
    estimateMetric,
    hitChance
} from 'src/app/optimizer/analytic-scorer';
import { TARGET } from 'src/app/optimizer/__tests__/fakes';

const basePlayer: CombatStats = {
    maxHit: 100,
    minHit: 10,
    accuracy: 1000,
    attackInterval: 2400
};

const baseTarget: TargetStats = {
    hitpoints: 500,
    evasion: 1000
};

function player(overrides: Partial<CombatStats>): CombatStats {
    return { ...basePlayer, ...overrides };
}

function target(overrides: Partial<TargetStats>): TargetStats {
    return { ...baseTarget, ...overrides };
}

describe('hitChance', () => {
    it('is 0.5 when accuracy equals evasion (formula boundary)', () => {
        expect(hitChance(1000, 1000)).toBeCloseTo(0.5, 10);
    });

    it('stays strictly within (0, 1) and is monotonic in accuracy', () => {
        const lower = hitChance(500, 1000);
        const mid = hitChance(1000, 1000);
        const higher = hitChance(2000, 1000);
        expect(lower).toBeGreaterThan(0);
        expect(higher).toBeLessThan(1);
        expect(lower).toBeLessThan(mid);
        expect(mid).toBeLessThan(higher);
    });

    it('strictly decreases as evasion increases', () => {
        const easy = hitChance(1000, 500);
        const even = hitChance(1000, 1000);
        const hard = hitChance(1000, 4000);
        expect(easy).toBeGreaterThan(even);
        expect(even).toBeGreaterThan(hard);
    });

    it('handles degenerate ratings without NaN/Infinity', () => {
        expect(hitChance(0, 1000)).toBe(0);
        expect(hitChance(1000, 0)).toBe(1);
    });
});

describe('averageHitDamage', () => {
    it('is the midpoint of the [min, max] roll', () => {
        expect(averageHitDamage(player({ minHit: 10, maxHit: 100 }))).toBe(55);
    });

    it('increases with maxHit', () => {
        const low = averageHitDamage(player({ maxHit: 50 }));
        const high = averageHitDamage(player({ maxHit: 200 }));
        expect(high).toBeGreaterThan(low);
    });
});

describe('estimateDps', () => {
    it('increases as the attack interval shrinks (faster = more DPS)', () => {
        const slow = estimateDps(player({ attackInterval: 4000 }), baseTarget);
        const fast = estimateDps(player({ attackInterval: 1600 }), baseTarget);
        expect(fast).toBeGreaterThan(slow);
    });

    it('increases with accuracy', () => {
        const lessAccurate = estimateDps(player({ accuracy: 500 }), baseTarget);
        const moreAccurate = estimateDps(player({ accuracy: 4000 }), baseTarget);
        expect(moreAccurate).toBeGreaterThan(lessAccurate);
    });
});

describe('estimateMetric — kills', () => {
    it('rises with maxHit', () => {
        const weak = estimateMetric(player({ maxHit: 50 }), baseTarget, 'kills');
        const strong = estimateMetric(player({ maxHit: 300 }), baseTarget, 'kills');
        expect(strong).toBeGreaterThan(weak);
    });

    it('rises with accuracy', () => {
        const weak = estimateMetric(player({ accuracy: 400 }), baseTarget, 'kills');
        const strong = estimateMetric(player({ accuracy: 5000 }), baseTarget, 'kills');
        expect(strong).toBeGreaterThan(weak);
    });

    it('falls as the target gains hitpoints (tankier = fewer kills/sec)', () => {
        const squishy = estimateMetric(basePlayer, target({ hitpoints: 200 }), 'kills');
        const tanky = estimateMetric(basePlayer, target({ hitpoints: 2000 }), 'kills');
        expect(tanky).toBeLessThan(squishy);
    });

    it('falls as the target gains evasion (harder to hit = fewer kills/sec)', () => {
        const easy = estimateMetric(basePlayer, target({ evasion: 250 }), 'kills');
        const evasive = estimateMetric(basePlayer, target({ evasion: 8000 }), 'kills');
        expect(evasive).toBeLessThan(easy);
    });

    it('rises as the attack interval shrinks', () => {
        const slow = estimateMetric(player({ attackInterval: 4800 }), baseTarget, 'kills');
        const fast = estimateMetric(player({ attackInterval: 1200 }), baseTarget, 'kills');
        expect(fast).toBeGreaterThan(slow);
    });
});

describe('estimateMetric — xp', () => {
    it('rises with maxHit (more damage dealt per second)', () => {
        const weak = estimateMetric(player({ maxHit: 50 }), baseTarget, 'xp');
        const strong = estimateMetric(player({ maxHit: 300 }), baseTarget, 'xp');
        expect(strong).toBeGreaterThan(weak);
    });

    it('rises with accuracy', () => {
        const weak = estimateMetric(player({ accuracy: 400 }), baseTarget, 'xp');
        const strong = estimateMetric(player({ accuracy: 5000 }), baseTarget, 'xp');
        expect(strong).toBeGreaterThan(weak);
    });

    it('falls as the target gains evasion', () => {
        const easy = estimateMetric(basePlayer, target({ evasion: 250 }), 'xp');
        const evasive = estimateMetric(basePlayer, target({ evasion: 8000 }), 'xp');
        expect(evasive).toBeLessThan(easy);
    });

    it('is independent of target hitpoints (xp tracks damage, not kills)', () => {
        const low = estimateMetric(basePlayer, target({ hitpoints: 100 }), 'xp');
        const high = estimateMetric(basePlayer, target({ hitpoints: 10000 }), 'xp');
        expect(high).toBe(low);
    });
});

describe('AnalyticScorer (Scorer adapter)', () => {
    it('is a maximizing scorer', () => {
        expect(new AnalyticScorer('kills').isMaximize()).toBe(true);
    });

    it('returns a usable metric once stats are pushed via setStats', async () => {
        const scorer = new AnalyticScorer('kills');
        scorer.setStats(basePlayer, baseTarget);
        const evaluation = await scorer.evaluate(TARGET, 200, 1000);
        expect(evaluation.success).toBe(true);
        expect(evaluation.metric).toBe(estimateMetric(basePlayer, baseTarget, 'kills'));
        expect(evaluation.deathRate).toBe(0);
    });

    it('fails gracefully when no stats have been supplied', async () => {
        const scorer = new AnalyticScorer('kills');
        const evaluation = await scorer.evaluate(TARGET, 200, 1000);
        expect(evaluation.success).toBe(false);
        expect(Number.isNaN(evaluation.metric)).toBe(true);
    });

    it('pulls stats lazily from a statsProvider when given one', async () => {
        let pulls = 0;
        const scorer = new AnalyticScorer('xp', () => {
            pulls++;
            return { player: basePlayer, target: baseTarget };
        });
        const evaluation = await scorer.evaluate(TARGET, 200, 1000);
        expect(pulls).toBe(1);
        expect(evaluation.metric).toBe(estimateMetric(basePlayer, baseTarget, 'xp'));
    });

    it('ranks a stronger loadout above a weaker one (pre-rank ordering)', async () => {
        const strong = new AnalyticScorer('kills');
        strong.setStats(player({ maxHit: 400, accuracy: 5000 }), baseTarget);
        const weak = new AnalyticScorer('kills');
        weak.setStats(player({ maxHit: 40, accuracy: 300 }), baseTarget);

        const strongEval = await strong.evaluate(TARGET, 200, 1000);
        const weakEval = await weak.evaluate(TARGET, 200, 1000);
        expect(strongEval.metric).toBeGreaterThan(weakEval.metric);
    });
});
