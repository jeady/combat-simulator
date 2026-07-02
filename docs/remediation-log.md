
## Workstream B

### B3 — slayer-task evaluation through the worker pool

`GameScorer.evaluateSlayerTask` now dispatches all accessible task monsters
concurrently through the worker pool (via `simulateManySettled`) when a pool is
present; the pool-less scorer keeps the serial path. Headless tests can't cover
this (it needs `Global`), so the settled-dispatch plumbing is verified by the
`worker-pool.test.ts` `simulateManySettled` tests.

VERIFY IN-GAME: run auto-optimize against a slayer task with ~8 reachable
monsters using 8 workers; each candidate's per-monster sims should now run in
parallel, giving an ~N× (up to worker count) speedup on the slayer path versus
the previous serial per-monster loop.

### B4 — attack-style dimension (implemented)

Attack style IS a clean `Settings` field: `Settings.styles` is
`{ magic: string; melee: string; ranged: string }`, one selected attack-style
id per attack type, round-tripped by `SettingsController` (export/import) and
applied by the equipment page (`equipment.ts` `_import` sets
`player.attackStyles[type]`). Only the entry matching the player's CURRENT
attack type is live.

Implemented `attackStyleDimension()` in `adapters.ts` via the existing
`settingsDimension` helper: it reads/writes `Settings.styles[currentAttackType]`
and re-reads the legal candidate set each pass (the search changes the weapon,
hence the attack type). Candidates mirror the config dropdown
(`_setAttackStyleDropdown`): `game.attackStyles` filtered to the player's
current `attackType`. Wired into `buildDimensions` behind
`options.attackStyle ?? true`; the `attackStyle?: boolean` option lives in the
inline options type in `adapters.ts` (owned by B), so no `types.ts` edit was
needed. No headless test: the dimension is built entirely from `Global.*`
(like the existing spell/agility/cartography dimensions), so it can't run under
vitest. VERIFY IN-GAME: optimize a melee build and confirm stab/slash/block are
searched and the best style is applied.

## Workstream D

### D — adapter contract tests

New file `src/app/optimizer/__tests__/adapters-contract.test.ts` (25 tests). The
game-coupled `adapters.ts` had zero tests; the pure logic inside its functions is
now exercised headless by stubbing `Global` (via `vi.mock('src/app/global', ...)`)
and `Lookup.isSlayerTask` (via `vi.mock('src/shared/utils/lookup', ...)`) with
in-memory fakes. The mocks live ONLY in the test file, so the purity boundary of
`adapters.ts` is unchanged (it was not edited).

Covered:
- `GameCandidateProvider.getCandidates`: unknown-slot, validSlots,
  Empty/DEBUG/golbin exclusion, equip-requirement filtering (modded items skip
  the check), owned/all pool membership, `current`/`any` attack-type constraint,
  ammo↔weapon coupling (arrows survive only with a matching ranged weapon; passive
  quiver items always pass), special-effect items exempt from the dominance prune,
  a genuinely stat-dominated plain item IS pruned, and combat-identical stat-pure
  items collapse to one representative. **B1 regression**: a fast-weak weapon and a
  slow-strong weapon both survive (attackSpeed is lower-is-better, so neither
  dominates), plus a control where a fast-strong weapon correctly dominates a
  slow-weak one.
- `summonSynergyDimension`: candidates = empty option + declared pairs whose members
  are both available; a pair with an unavailable (unowned) member is dropped;
  `applyChoice` clears both summon slots before equipping (proven by a stale tablet);
  the empty choice clears both slots; `getCurrentChoice` reads the equipped pair and
  `equals` is order-insensitive; the defensive fallback to the empty option when the
  synergy data shape is unreadable (throwing accessor).
- `slayerTaskTargetId` / `isSupportedTarget`: no-target, task carried in `entityId`,
  task carried in `monsterId` (dropdown path), plain monster, `entityId` preferred
  over a non-task `monsterId`; `isSupportedTarget` false for no target, true for a
  plain monster, and true iff ≥1 task monster is reachable.

IN-GAME-VERIFY-ONLY (not covered here):
- `GameLoadoutApplier` — needs real `SettingsController` export/import round-trips
  (out of scope per the plan; in-game verification only).
- `GameScorer` sim paths — need the real worker / Monte-Carlo sim (out of scope).
- `foodSignature` / `combatPotionIds` candidate shaping (scope item 4) — reviewed
  and STOPPED per the plan's "stop where stubbing cost explodes and log" rule: both
  helpers are module-private and neither the food nor potion dimension is exported
  individually (they're assembled inside the game-coupled `buildDimensions`).
  Reaching them would require stubbing the full herblore recipe/potion-tier and food
  registries through the private wrappers for no additional pure-logic coverage — the
  de-dupe/collapse core is already covered headless by `dedupe.test.ts`.
