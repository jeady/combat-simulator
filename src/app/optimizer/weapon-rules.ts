/**
 * Pure weapon / attack-type / ammo rules for candidate filtering.
 *
 * Kept game-agnostic (no `Global.*`) so it's unit-testable headless: callers in `adapters.ts` read
 * the real item fields (`WeaponItem.attackType` / `ammoTypeRequired`, ammo `ammoType`, the player's
 * current `attackType`) and pass the plain values in. See `docs/auto-optimize-design.md`.
 */

/** The three combat attack types a weapon can have. */
export type AttackType = 'melee' | 'ranged' | 'magic';

/**
 * What the user wants the weapon search constrained to. `current` locks it to whatever attack type is
 * configured on the character (so a magic build isn't handed a melee weapon); `any` searches across
 * all types; a specific type forces that one.
 */
export type AttackTypeConstraint = AttackType | 'current' | 'any';

/**
 * Resolve a constraint to the concrete attack type the weapon search must stay within, or `undefined`
 * for "no constraint" (search every type). `current` maps to the character's present attack type.
 */
export function resolveAttackTypeConstraint(
    constraint: AttackTypeConstraint,
    currentAttackType: AttackType | undefined
): AttackType | undefined {
    if (constraint === 'any') {
        return undefined;
    }
    if (constraint === 'current') {
        return currentAttackType;
    }
    return constraint;
}

/**
 * Should a weapon candidate be kept under a resolved attack-type target? A non-weapon (no attack type)
 * is never filtered here; with no target, everything passes.
 */
export function weaponAllowedByAttackType(
    weaponAttackType: AttackType | undefined,
    target: AttackType | undefined
): boolean {
    if (target === undefined || weaponAttackType === undefined) {
        return true;
    }
    return weaponAttackType === target;
}

/**
 * Should a weapon candidate be kept given the damage-type immunities of the run's target? A monster
 * ignores attacker damage of any type in its own damage type's `immuneTo` set (e.g. abyssal monsters
 * ignore Normal damage), so a weapon dealing an immune type can never kill it — simming it just burns
 * the full tick budget on every trial and fails. Non-weapons (no damage type) are never filtered
 * here; with no immunity set, everything passes.
 */
export function weaponAllowedByTargetImmunity(
    weaponDamageTypeId: string | undefined,
    targetImmuneDamageTypeIds: ReadonlySet<string> | undefined
): boolean {
    if (weaponDamageTypeId === undefined || targetImmuneDamageTypeIds === undefined) {
        return true;
    }
    return !targetImmuneDamageTypeIds.has(weaponDamageTypeId);
}

/**
 * Is an ammo item usable with the equipped weapon? Ammo (identified by having an `ammoType`) is only
 * useful to a ranged weapon whose `ammoTypeRequired` matches — otherwise it contributes nothing to the
 * fight (e.g. arrows on a melee build), so it shouldn't be a search candidate. Items with no ammo type
 * (passive quiver items) are not ammo and this rule doesn't apply to them.
 */
export function ammoUsableWithWeapon(
    ammoType: number | undefined,
    weaponIsRanged: boolean,
    weaponAmmoTypeRequired: number | undefined
): boolean {
    if (ammoType === undefined) {
        return true; // not ammo — a passive quiver item; leave to the normal filters
    }
    return weaponIsRanged && weaponAmmoTypeRequired !== undefined && ammoType === weaponAmmoTypeRequired;
}
