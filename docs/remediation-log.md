
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
