/**
 * Contract tests for the game-backed optimizer adapters (`adapters.ts`). `adapters.ts` is the only
 * optimizer module allowed to touch `Global.*`, and full fidelity needs the running game — but the
 * PURE logic inside the adapter functions (candidate filtering, dominance pruning direction, summon
 * synergy shaping, slayer-task / dungeon-aggregate target detection, consumable candidate shaping)
 * can be exercised headless by
 * stubbing `Global` and `Lookup` with in-memory fakes.
 *
 * The mocks live ONLY in this test file (via vi.mock) — `adapters.ts` itself stays untouched, so the
 * purity boundary is unchanged. Everything the adapters read off the game is modelled by the minimal
 * `FakeGame` / registry shapes below; nothing here needs a real save, worker, or Monte-Carlo sim.
 *
 * What remains in-game-verify-only (logged in docs/remediation-log.md): GameLoadoutApplier's
 * SettingsController round-trips and GameScorer's worker sim paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A single mutable game object the mocked `Global` points at; each test rebuilds it via setGame().
// Declared with vi.hoisted so the vi.mock factory (hoisted above imports) can close over it.
const state = vi.hoisted(() => ({
    game: undefined as any,
    melvor: undefined as any,
    simulation: undefined as any
}));

// Stub the two game-coupled modules the adapters import. Only the members the adapters actually read
// are provided; anything else is intentionally absent so an unexpected access fails loudly.
vi.mock('src/app/global', () => ({
    Global: {
        get game() {
            return state.game;
        },
        get melvor() {
            return state.melvor;
        },
        get simulation() {
            return state.simulation;
        },
        logger: { warn: () => {}, error: () => {}, info: () => {} }
    }
}));

const isSlayerTaskMock = vi.hoisted(() => vi.fn((id: string | undefined) => false));
const isDungeonMock = vi.hoisted(() => vi.fn((id: string | undefined) => false));
const isStrongholdMock = vi.hoisted(() => vi.fn((id: string | undefined) => false));
const isDepthMock = vi.hoisted(() => vi.fn((id: string | undefined) => false));
const getMonsterListMock = vi.hoisted(() => vi.fn((id: string): { id: string }[] => []));
const getMonsterByIdMock = vi.hoisted(() => vi.fn((id: string): { id: string } | undefined => undefined));
vi.mock('src/shared/utils/lookup', () => ({
    Lookup: {
        isSlayerTask: isSlayerTaskMock,
        isDungeon: isDungeonMock,
        isStronghold: isStrongholdMock,
        isDepth: isDepthMock,
        getMonsterList: getMonsterListMock,
        monsters: { getObjectByID: getMonsterByIdMock }
    }
}));

import {
    GameCandidateProvider,
    GameLoadoutApplier,
    slayerTaskTargetId,
    dungeonTargetId,
    isSupportedTarget,
    summonSynergyDimension
} from 'src/app/optimizer/adapters';
import { SummonChoice } from 'src/app/optimizer/synergy';

const EMPTY_ITEM = 'melvorD:Empty_Equipment';
const WEAPON_SLOT = 'melvorD:Weapon';
const QUIVER_SLOT = 'melvorD:Quiver';
const SUMMON_SLOT_1 = 'melvorD:Summon1';
const SUMMON_SLOT_2 = 'melvorD:Summon2';

/** A stat entry as it appears on `item.equipmentStats` (damageType optional). */
interface StatEntry {
    key: string;
    value: number;
    damageType?: { id: string };
}

/** The subset of an equipment item the adapters read. */
interface FakeItem {
    id: string;
    name?: string;
    validSlots: { id: string }[];
    /** Slots this item ALSO occupies (e.g. a 2H weapon's shield slot); empty for most items. */
    occupiesSlots?: { id: string }[];
    equipmentStats?: StatEntry[];
    isModded?: boolean;
    golbinRaidExclusive?: boolean;
    equipRequirements?: unknown;
    /** weapons only */
    attackType?: 'melee' | 'ranged' | 'magic';
    ammoTypeRequired?: number;
    /** ammo only */
    ammoType?: number;
    // Special-effect fields (any non-empty => exempt from the dominance prune).
    modifiers?: unknown;
    enemyModifiers?: unknown;
    conditionalModifiers?: unknown;
    specialAttacks?: unknown;
    combatEffects?: unknown;
    /** Whether the character has ever found this item (drives the owned pool). */
    owned?: boolean;
}

/** A tiny id-keyed registry mirroring the game's NamespaceRegistry.getObjectByID / .allObjects. */
function registry<T extends { id: string }>(objects: T[]) {
    const byId = new Map(objects.map(o => [o.id, o]));
    return {
        allObjects: objects,
        getObjectByID: (id: string) => byId.get(id),
        filter: (fn: (o: T) => boolean) => objects.filter(fn)
    };
}

/**
 * Build the minimal `Global.game` / `Global.melvor` the adapters touch from a list of items, plus a
 * mutable equipped-set so GameLoadoutApplier / summonSynergyDimension have somewhere to read and write.
 * `equipRequirements` on an item is treated as the "unmet" marker: checkRequirements returns false for
 * it (models a too-high-level item being filtered out).
 */
function buildGame(items: FakeItem[], startEquipped: Record<string, string> = {}) {
    const equipment = new Map<string, FakeItem>();
    for (const [slotId, itemId] of Object.entries(startEquipped)) {
        const item = items.find(i => i.id === itemId);
        if (item) {
            equipment.set(slotId, item);
        }
    }

    const player: any = {
        attackType: 'melee' as 'melee' | 'ranged' | 'magic',
        equipment: {
            getItemInSlot: (slotId: string) =>
                equipment.get(slotId) ?? ({ id: EMPTY_ITEM } as FakeItem),
            equippedItems: new Proxy(
                {},
                {
                    get: (_t, slotId: string) => {
                        const item = equipment.get(slotId);
                        return item ? { item } : undefined;
                    }
                }
            ) as Record<string, { item: FakeItem } | undefined>
        },
        unequipItem: (_set: number, slot: { id: string }) => equipment.delete(slot.id),
        // Mirrors the real equipItem(item, set, slot, qty, isImporting): put the item in its slot.
        equipItem: (item: FakeItem, _set: number, slot: { id: string }) => equipment.set(slot.id, item)
    };

    const slotIds = [WEAPON_SLOT, QUIVER_SLOT, SUMMON_SLOT_1, SUMMON_SLOT_2, 'melvorD:Helmet', 'melvorD:Platebody'];

    const game: any = {
        equipmentSlots: registry(slotIds.map(id => ({ id }))),
        items: {
            equipment: registry(items),
            getObjectByID: (id: string) => items.find(i => i.id === id)
        },
        combat: { player },
        // An item's presence in `equipRequirements` marks it as failing the requirement check.
        checkRequirements: (reqs: unknown) => !reqs,
        summoning: { synergies: [] as any[] },
        // Exposed so summon tests can drive equip/unequip directly.
        _equipment: equipment
    };

    // The owned pool reads Global.melvor.items.getObjectByID(id) then itemFindCount(item) > 0.
    const melvor: any = {
        items: { getObjectByID: (id: string) => items.find(i => i.id === id) },
        stats: { itemFindCount: (item: FakeItem) => (item.owned ? 1 : 0) }
    };

    return { game, melvor, player, equipment };
}

/** Install a fake game/melvor as what the mocked Global returns. */
function setGame(built: ReturnType<typeof buildGame>) {
    state.game = built.game;
    state.melvor = built.melvor;
}

beforeEach(() => {
    isSlayerTaskMock.mockReset();
    isSlayerTaskMock.mockReturnValue(false);
    isDungeonMock.mockReset();
    isDungeonMock.mockReturnValue(false);
    isStrongholdMock.mockReset();
    isStrongholdMock.mockReturnValue(false);
    isDepthMock.mockReset();
    isDepthMock.mockReturnValue(false);
    getMonsterListMock.mockReset();
    getMonsterListMock.mockReturnValue([]);
    getMonsterByIdMock.mockReset();
    getMonsterByIdMock.mockReturnValue(undefined);
    state.game = undefined;
    state.melvor = undefined;
    state.simulation = undefined;
});

/**
 * Scope item 1 — GameCandidateProvider.getCandidates. A stub Global.game exposing a small item
 * fixture drives each filter path: validSlots, equip requirements, pool membership, attack-type
 * constraint, ammo-vs-weapon coupling, special-effect prune exemption, and the B1 dominance-direction
 * regression (a fast-weak weapon must survive against a slow-strong one).
 */
describe('GameCandidateProvider.getCandidates', () => {
    it('returns [] for an unknown slot', () => {
        setGame(buildGame([]));
        const provider = new GameCandidateProvider('all', 'any');
        expect(provider.getCandidates('melvorD:NotASlot')).toEqual([]);
    });

    it('filters by validSlots — only items valid for the queried slot are candidates', () => {
        setGame(
            buildGame([
                { id: 'helm', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'a', value: 1 }] },
                { id: 'body', validSlots: [{ id: 'melvorD:Platebody' }], owned: true, equipmentStats: [{ key: 'a', value: 1 }] }
            ])
        );
        const provider = new GameCandidateProvider('all', 'any');
        expect(provider.getCandidates('melvorD:Helmet')).toEqual(['helm']);
    });

    it('drops Empty/DEBUG/golbin-raid items regardless of slot validity', () => {
        setGame(
            buildGame([
                { id: EMPTY_ITEM, validSlots: [{ id: 'melvorD:Helmet' }], owned: true },
                { id: 'melvorD:DEBUG_ITEM', validSlots: [{ id: 'melvorD:Helmet' }], owned: true },
                { id: 'golbin', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, golbinRaidExclusive: true },
                { id: 'real', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'a', value: 1 }] }
            ])
        );
        const provider = new GameCandidateProvider('all', 'any');
        expect(provider.getCandidates('melvorD:Helmet')).toEqual(['real']);
    });

    it('filters by equip requirements (unmet requirement => dropped), but modded items skip the check', () => {
        setGame(
            buildGame([
                // Distinct stat keys so no item dominates another — the requirement filter alone decides.
                { id: 'metReq', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'a', value: 1 }] },
                {
                    id: 'unmet',
                    validSlots: [{ id: 'melvorD:Helmet' }],
                    owned: true,
                    equipRequirements: { level: 99 },
                    equipmentStats: [{ key: 'b', value: 2 }]
                },
                {
                    id: 'moddedUnmet',
                    validSlots: [{ id: 'melvorD:Helmet' }],
                    owned: true,
                    isModded: true,
                    equipRequirements: { level: 99 },
                    equipmentStats: [{ key: 'c', value: 3 }]
                }
            ])
        );
        const provider = new GameCandidateProvider('all', 'any');
        // metReq and moddedUnmet survive; unmet is dropped. All stat-distinct, so no pruning collapses them.
        expect(provider.getCandidates('melvorD:Helmet').sort()).toEqual(['metReq', 'moddedUnmet'].sort());
    });

    it('filters by the owned pool: owned-only keeps only found items; all keeps everything', () => {
        // Distinct stat keys so neither dominates the other — the pool filter alone decides.
        const items: FakeItem[] = [
            { id: 'have', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'a', value: 1 }] },
            { id: 'missing', validSlots: [{ id: 'melvorD:Helmet' }], owned: false, equipmentStats: [{ key: 'b', value: 2 }] }
        ];
        setGame(buildGame(items));
        expect(new GameCandidateProvider('owned', 'any').getCandidates('melvorD:Helmet')).toEqual(['have']);

        setGame(buildGame(items));
        expect(new GameCandidateProvider('all', 'any').getCandidates('melvorD:Helmet').sort()).toEqual(
            ['have', 'missing'].sort()
        );
    });

    it("attack-type constraint 'current' keeps only weapons of the player's attack type", () => {
        const items: FakeItem[] = [
            { id: 'meleeSword', validSlots: [{ id: WEAPON_SLOT }], owned: true, attackType: 'melee', equipmentStats: [{ key: 'a', value: 1 }] },
            { id: 'rangedBow', validSlots: [{ id: WEAPON_SLOT }], owned: true, attackType: 'ranged', equipmentStats: [{ key: 'b', value: 1 }] },
            { id: 'magicStaff', validSlots: [{ id: WEAPON_SLOT }], owned: true, attackType: 'magic', equipmentStats: [{ key: 'c', value: 1 }] }
        ];
        const built = buildGame(items);
        built.player.attackType = 'melee';
        setGame(built);
        expect(new GameCandidateProvider('all', 'current').getCandidates(WEAPON_SLOT)).toEqual(['meleeSword']);

        // 'any' searches every attack type — all three weapons survive (they are stat-distinct).
        const built2 = buildGame(items);
        built2.player.attackType = 'melee';
        setGame(built2);
        expect(new GameCandidateProvider('all', 'any').getCandidates(WEAPON_SLOT).sort()).toEqual(
            ['magicStaff', 'meleeSword', 'rangedBow'].sort()
        );
    });

    it('couples ammo to the equipped weapon: arrows survive only with a matching ranged weapon', () => {
        const arrow: FakeItem = { id: 'arrow', validSlots: [{ id: QUIVER_SLOT }], owned: true, ammoType: 0, equipmentStats: [{ key: 'rangedStrengthBonus', value: 5 }] };
        const bolt: FakeItem = { id: 'bolt', validSlots: [{ id: QUIVER_SLOT }], owned: true, ammoType: 1, equipmentStats: [{ key: 'rangedStrengthBonus', value: 6 }] };
        const cape: FakeItem = { id: 'passiveQuiver', validSlots: [{ id: QUIVER_SLOT }], owned: true, equipmentStats: [{ key: 'stabAttackBonus', value: 3 }] };
        const bow: FakeItem = { id: 'bow', validSlots: [{ id: WEAPON_SLOT }], owned: true, attackType: 'ranged', ammoTypeRequired: 0 };

        // Ranged weapon (ammoTypeRequired 0) equipped: only ammoType 0 (arrow) fits; bolt is dropped;
        // the passive (no ammoType) quiver item always passes.
        const built = buildGame([arrow, bolt, cape, bow], { [WEAPON_SLOT]: 'bow' });
        built.player.attackType = 'ranged';
        setGame(built);
        expect(new GameCandidateProvider('all', 'any').getCandidates(QUIVER_SLOT).sort()).toEqual(
            ['arrow', 'passiveQuiver'].sort()
        );

        // Melee build (no ranged weapon): all real ammo is useless, only the passive item survives.
        const built2 = buildGame([arrow, bolt, cape]);
        built2.player.attackType = 'melee';
        setGame(built2);
        expect(new GameCandidateProvider('all', 'any').getCandidates(QUIVER_SLOT)).toEqual(['passiveQuiver']);
    });

    it('never prunes special-effect items even when stat-dominated by another candidate', () => {
        setGame(
            buildGame([
                // A plainly-dominant stat-pure item.
                { id: 'strong', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'stabAttackBonus', value: 10 }] },
                // A stat-weak item, but it carries a modifier — its value isn't captured by stats, so it
                // must survive the dominance prune.
                {
                    id: 'special',
                    validSlots: [{ id: 'melvorD:Helmet' }],
                    owned: true,
                    equipmentStats: [{ key: 'stabAttackBonus', value: 1 }],
                    modifiers: { someModifier: 1 }
                }
            ])
        );
        const result = new GameCandidateProvider('all', 'any').getCandidates('melvorD:Helmet');
        expect(result).toContain('special');
        expect(result).toContain('strong');
    });

    it('prunes a strictly stat-dominated plain item', () => {
        setGame(
            buildGame([
                { id: 'better', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'stabAttackBonus', value: 10 }] },
                { id: 'worse', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'stabAttackBonus', value: 5 }] }
            ])
        );
        expect(new GameCandidateProvider('all', 'any').getCandidates('melvorD:Helmet')).toEqual(['better']);
    });

    // B1 REGRESSION: attackSpeed is lower-is-better. A fast-weak weapon and a slow-strong weapon are
    // on opposite sides of a real trade-off; neither dominates the other once attackSpeed's direction
    // is flipped for the prune. Before B1, the raw (higher-is-better) comparison wrongly treated the
    // slow weapon's larger attackSpeed as an advantage, letting it dominate — dropping the fast weapon.
    it('B1: a fast-weak weapon survives against a slow-strong one (attackSpeed direction)', () => {
        setGame(
            buildGame([
                {
                    id: 'fastWeak',
                    validSlots: [{ id: WEAPON_SLOT }],
                    owned: true,
                    attackType: 'melee',
                    equipmentStats: [{ key: 'meleeStrengthBonus', value: 5 }, { key: 'attackSpeed', value: 2000 }]
                },
                {
                    id: 'slowStrong',
                    validSlots: [{ id: WEAPON_SLOT }],
                    owned: true,
                    attackType: 'melee',
                    equipmentStats: [{ key: 'meleeStrengthBonus', value: 10 }, { key: 'attackSpeed', value: 3000 }]
                }
            ])
        );
        const result = new GameCandidateProvider('all', 'any').getCandidates(WEAPON_SLOT).sort();
        expect(result).toEqual(['fastWeak', 'slowStrong'].sort());
    });

    it('B1 control: the slow weapon IS dropped when it is also weaker (genuinely dominated)', () => {
        setGame(
            buildGame([
                {
                    id: 'fastStrong',
                    validSlots: [{ id: WEAPON_SLOT }],
                    owned: true,
                    attackType: 'melee',
                    equipmentStats: [{ key: 'meleeStrengthBonus', value: 10 }, { key: 'attackSpeed', value: 2000 }]
                },
                {
                    id: 'slowWeak',
                    validSlots: [{ id: WEAPON_SLOT }],
                    owned: true,
                    attackType: 'melee',
                    equipmentStats: [{ key: 'meleeStrengthBonus', value: 5 }, { key: 'attackSpeed', value: 3000 }]
                }
            ])
        );
        // fastStrong is >= on strength (10>5) AND better (lower) on attackSpeed => truly dominates.
        expect(new GameCandidateProvider('all', 'any').getCandidates(WEAPON_SLOT)).toEqual(['fastStrong']);
    });

    it('collapses combat-identical stat-pure items to a single representative', () => {
        setGame(
            buildGame([
                { id: 'twinA', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'stabAttackBonus', value: 4 }] },
                { id: 'twinB', validSlots: [{ id: 'melvorD:Helmet' }], owned: true, equipmentStats: [{ key: 'stabAttackBonus', value: 4 }] }
            ])
        );
        const result = new GameCandidateProvider('all', 'any').getCandidates('melvorD:Helmet');
        expect(result).toHaveLength(1);
        expect(['twinA', 'twinB']).toContain(result[0]);
    });
});

/**
 * Scope item 2 — summonSynergyDimension. Candidates = the empty option + every declared pair whose
 * BOTH members are available; applyChoice clears both slots before equipping; equals is
 * order-insensitive. The synergy list is stubbed on Global.game.summoning.synergies.
 */
describe('summonSynergyDimension', () => {
    /** A summon tablet valid for either summon slot (occupiesSlots empty — no secondary slots). */
    function tablet(id: string, owned = true): FakeItem {
        return {
            id,
            name: id,
            validSlots: [{ id: SUMMON_SLOT_1 }, { id: SUMMON_SLOT_2 }],
            occupiesSlots: [],
            owned
        };
    }

    /** A synergy whose two members map to the given product (tablet) ids. */
    function synergy(a: string, b: string) {
        return { summons: [{ product: { id: a } }, { product: { id: b } }] };
    }

    it('offers the empty option plus declared pairs whose members are both available', () => {
        const built = buildGame([tablet('famA'), tablet('famB'), tablet('lone')]);
        built.game.summoning.synergies = [synergy('famA', 'famB'), synergy('famA', 'lone')];
        setGame(built);

        const dim = summonSynergyDimension(new GameLoadoutApplier(), false);
        const choices = dim.getCandidates() as SummonChoice[];
        const keys = choices.map(c => `${c.first ?? ''}|${c.second ?? ''}`).sort();
        // empty, {famA,famB}, {famA,lone} — pairs only (per-slot dims cover singles), members available.
        expect(keys).toEqual(['|', 'famA|famB', 'famA|lone'].sort());
    });

    it('drops a declared pair whose member is not available (unowned in owned-only mode)', () => {
        const built = buildGame([tablet('famA', true), tablet('famB', false)]);
        built.game.summoning.synergies = [synergy('famA', 'famB')];
        setGame(built);

        const dim = summonSynergyDimension(new GameLoadoutApplier(), true /* ownedOnly */);
        const choices = dim.getCandidates() as SummonChoice[];
        // famB unowned => pair dropped => only the empty option remains.
        expect(choices).toHaveLength(1);
        expect(choices[0]).toEqual({});
    });

    it('applyChoice clears both summon slots then equips the chosen pair', () => {
        // Start with a stale tablet in slot 1 to prove the clear happens before the equip.
        const built = buildGame([tablet('famA'), tablet('famB'), tablet('stale')], { [SUMMON_SLOT_1]: 'stale' });
        built.game.summoning.synergies = [synergy('famA', 'famB')];
        setGame(built);

        const dim = summonSynergyDimension(new GameLoadoutApplier(), false);
        dim.applyChoice({ first: 'famA', second: 'famB' });

        expect(built.equipment.get(SUMMON_SLOT_1)?.id).toBe('famA');
        expect(built.equipment.get(SUMMON_SLOT_2)?.id).toBe('famB');
    });

    it('applyChoice with the empty choice clears both summon slots', () => {
        const built = buildGame([tablet('famA'), tablet('famB')], {
            [SUMMON_SLOT_1]: 'famA',
            [SUMMON_SLOT_2]: 'famB'
        });
        built.game.summoning.synergies = [synergy('famA', 'famB')];
        setGame(built);

        const dim = summonSynergyDimension(new GameLoadoutApplier(), false);
        dim.applyChoice({});

        expect(built.equipment.get(SUMMON_SLOT_1)).toBeUndefined();
        expect(built.equipment.get(SUMMON_SLOT_2)).toBeUndefined();
    });

    it('getCurrentChoice reads the equipped pair; equals is order-insensitive', () => {
        const built = buildGame([tablet('famA'), tablet('famB')], {
            [SUMMON_SLOT_1]: 'famA',
            [SUMMON_SLOT_2]: 'famB'
        });
        built.game.summoning.synergies = [synergy('famA', 'famB')];
        setGame(built);

        const dim = summonSynergyDimension(new GameLoadoutApplier(), false);
        const current = dim.getCurrentChoice();
        // Same pair in reversed order compares equal.
        expect(dim.equals(current, { first: 'famB', second: 'famA' })).toBe(true);
        expect(dim.equals(current, { first: 'famA' })).toBe(false);
    });

    it('falls back to the empty option only when the synergy data shape is unreadable', () => {
        const built = buildGame([tablet('famA'), tablet('famB')]);
        // A synergies accessor that throws models a surprising content-pack shape (defensive path).
        Object.defineProperty(built.game.summoning, 'synergies', {
            get() {
                throw new Error('unexpected synergy shape');
            }
        });
        setGame(built);

        const dim = summonSynergyDimension(new GameLoadoutApplier(), false);
        const choices = dim.getCandidates() as SummonChoice[];
        expect(choices).toHaveLength(1);
        expect(choices[0]).toEqual({});
    });
});

/**
 * Scope item 3 — slayerTaskTargetId / isSupportedTarget branches. Lookup.isSlayerTask is stubbed so
 * both the entityId and the monsterId slayer-task paths are exercised without the game.
 */
describe('slayerTaskTargetId / isSupportedTarget', () => {
    it('returns undefined for no target', () => {
        expect(slayerTaskTargetId(undefined)).toBeUndefined();
    });

    it('detects a slayer task carried in entityId', () => {
        isSlayerTaskMock.mockImplementation(id => id === 'task:A');
        expect(slayerTaskTargetId({ monsterId: 'm', entityId: 'task:A' })).toBe('task:A');
    });

    it('detects a slayer task carried in monsterId (dropdown selection, no entityId)', () => {
        isSlayerTaskMock.mockImplementation(id => id === 'task:A');
        expect(slayerTaskTargetId({ monsterId: 'task:A' })).toBe('task:A');
    });

    it('returns undefined for a plain monster (neither field is a task)', () => {
        isSlayerTaskMock.mockReturnValue(false);
        expect(slayerTaskTargetId({ monsterId: 'melvorD:Rat', entityId: 'melvorD:GolbinCave' })).toBeUndefined();
    });

    it('prefers the entityId task over a (non-task) monsterId', () => {
        isSlayerTaskMock.mockImplementation(id => id === 'task:A');
        expect(slayerTaskTargetId({ monsterId: 'melvorD:Rat', entityId: 'task:A' })).toBe('task:A');
    });

    it('isSupportedTarget is false for no target, true for a plain monster', () => {
        expect(isSupportedTarget(undefined)).toBe(false);
        isSlayerTaskMock.mockReturnValue(false);
        expect(isSupportedTarget({ monsterId: 'melvorD:Rat' })).toBe(true);
    });

    it('isSupportedTarget for a slayer task is true iff at least one task monster is reachable', () => {
        isSlayerTaskMock.mockImplementation(id => id === 'task:A');

        // Reachable => supported. isSupportedTarget reads Global.simulation.getAccessibleSlayerTaskMonsters.
        state.simulation = { getAccessibleSlayerTaskMonsters: (): { id: string }[] => [{ id: 'melvorD:Rat' }] };
        expect(isSupportedTarget({ monsterId: 'task:A' })).toBe(true);

        // No reachable task monster => unsupported (nothing to score).
        state.simulation = { getAccessibleSlayerTaskMonsters: (): { id: string }[] => [] };
        expect(isSupportedTarget({ monsterId: 'task:A' })).toBe(false);
    });
});

/**
 * Scope item 3b — dungeonTargetId / aggregate isSupportedTarget branches. The Lookup area checks
 * (isDungeon/isStronghold/isDepth), monster registry, and getMonsterList are stubbed so every
 * resolution branch runs without the game. The load-bearing cases: an area id arriving in
 * `monsterId` (the dungeon-level chart bar selected without inspecting — previously fell through to
 * the plain-monster path and failed every sim), and a real monster fought IN a dungeon context
 * (inspect selection) staying a single-monster target rather than being hijacked as an aggregate.
 */
describe('dungeonTargetId / aggregate isSupportedTarget', () => {
    it('returns undefined for no target and for a plain monster', () => {
        expect(dungeonTargetId(undefined)).toBeUndefined();
        expect(dungeonTargetId({ monsterId: 'melvorD:Rat' })).toBeUndefined();
    });

    it('detects a dungeon id carried in monsterId (aggregate bar selected without inspecting)', () => {
        isDungeonMock.mockImplementation(id => id === 'dung:A');
        expect(dungeonTargetId({ monsterId: 'dung:A' })).toBe('dung:A');
    });

    it('detects stronghold and abyss-depth ids the same way', () => {
        isStrongholdMock.mockImplementation(id => id === 'stronghold:A');
        isDepthMock.mockImplementation(id => id === 'depth:A');
        expect(dungeonTargetId({ monsterId: 'stronghold:A' })).toBe('stronghold:A');
        expect(dungeonTargetId({ monsterId: 'depth:A' })).toBe('depth:A');
    });

    it('does NOT hijack a real monster fought in a dungeon context (inspect selection)', () => {
        isDungeonMock.mockImplementation(id => id === 'dung:A');
        getMonsterByIdMock.mockImplementation(id => (id === 'melvorD:Boss' ? { id } : undefined));
        // { monsterId: <monster>, entityId: <dungeon> } is the supported single-fight sim.
        expect(dungeonTargetId({ monsterId: 'melvorD:Boss', entityId: 'dung:A' })).toBeUndefined();
    });

    it('falls back to an aggregate entityId when monsterId does not resolve to a real monster', () => {
        isDungeonMock.mockImplementation(id => id === 'dung:A');
        getMonsterByIdMock.mockReturnValue(undefined);
        expect(dungeonTargetId({ monsterId: 'not-a-monster', entityId: 'dung:A' })).toBe('dung:A');
    });

    it('isSupportedTarget for an aggregate is true iff the area has simmable monsters', () => {
        isDungeonMock.mockImplementation(id => id === 'dung:A');

        getMonsterListMock.mockReturnValue([{ id: 'melvorD:Boss' }]);
        expect(isSupportedTarget({ monsterId: 'dung:A' })).toBe(true);

        // No monsters in the area => nothing to score => unsupported (rejected up front by the UI).
        getMonsterListMock.mockReturnValue([]);
        expect(isSupportedTarget({ monsterId: 'dung:A' })).toBe(false);
    });

    it('a slayer-task target is never treated as a dungeon aggregate', () => {
        isSlayerTaskMock.mockImplementation(id => id === 'task:A');
        expect(dungeonTargetId({ monsterId: 'task:A' })).toBeUndefined();
    });
});

/**
 * Scope item 4 — foodSignature / combatPotionIds candidate shaping — was reviewed and left to
 * in-game verification (logged in docs/remediation-log.md). Both `foodSignature` and `combatPotionIds`
 * are module-private and NOT exported from adapters.ts, and neither the food nor the potion dimension
 * is individually exported (they're assembled inside the game-coupled `buildDimensions`). Their pure
 * cores are the de-dupe/collapse logic already covered headless by dedupe.test.ts; stubbing the full
 * herblore recipe/potion-tier registries and food registry to reach them through the private wrappers
 * is where the stubbing cost explodes for no additional coverage of pure logic, so per the plan's
 * "stop where stubbing cost explodes and log" rule this item stops here.
 */
