import { describe, expect, it } from 'vitest';
import {
    ammoUsableWithWeapon,
    resolveAttackTypeConstraint,
    weaponAllowedByAttackType
} from 'src/app/optimizer/weapon-rules';

describe('resolveAttackTypeConstraint', () => {
    it("maps 'current' to the character's present attack type", () => {
        expect(resolveAttackTypeConstraint('current', 'magic')).toBe('magic');
        expect(resolveAttackTypeConstraint('current', 'melee')).toBe('melee');
    });

    it("returns undefined for 'any' (unconstrained)", () => {
        expect(resolveAttackTypeConstraint('any', 'magic')).toBeUndefined();
    });

    it('passes a specific type through verbatim (ignores the current type)', () => {
        expect(resolveAttackTypeConstraint('ranged', 'melee')).toBe('ranged');
    });

    it("returns undefined when 'current' has no known type yet", () => {
        expect(resolveAttackTypeConstraint('current', undefined)).toBeUndefined();
    });
});

describe('weaponAllowedByAttackType', () => {
    it('keeps only weapons matching the target type', () => {
        expect(weaponAllowedByAttackType('magic', 'magic')).toBe(true);
        expect(weaponAllowedByAttackType('melee', 'magic')).toBe(false);
    });

    it('never filters when there is no target (any)', () => {
        expect(weaponAllowedByAttackType('melee', undefined)).toBe(true);
    });

    it('never filters a non-weapon (no attack type)', () => {
        expect(weaponAllowedByAttackType(undefined, 'magic')).toBe(true);
    });
});

describe('ammoUsableWithWeapon', () => {
    const ARROWS = 0;
    const BOLTS = 1;

    it('keeps ammo only for a matching ranged weapon', () => {
        expect(ammoUsableWithWeapon(ARROWS, true, ARROWS)).toBe(true); // arrows + bow
        expect(ammoUsableWithWeapon(ARROWS, true, BOLTS)).toBe(false); // arrows + crossbow (needs bolts)
    });

    it('drops ammo entirely for a non-ranged weapon', () => {
        expect(ammoUsableWithWeapon(ARROWS, false, undefined)).toBe(false); // arrows on a melee/magic build
    });

    it('leaves passive (non-ammo) quiver items alone', () => {
        expect(ammoUsableWithWeapon(undefined, false, undefined)).toBe(true);
        expect(ammoUsableWithWeapon(undefined, true, ARROWS)).toBe(true);
    });
});
