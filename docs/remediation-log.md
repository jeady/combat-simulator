# Auto-Optimize Remediation — Final Summary (Workstream E, 2026-07-02)

The remediation plan (Waves 1–2 across Workstreams A–D, then Wave-3 docs/integration as E) has
landed on branch `auto-optimize`. This section is the final integration record; the per-workstream
notes below (B, D) are the original authors' entries and are unchanged.

## Final gate status (from a clean checkout of the branch)

- `npm test`: **204/204 passing** (14 files).
- `npm run build`: **clean** — webpack compiled successfully, zip produced, no new type errors.
- **Purity boundary (rule 3): intact.** A grep of `src/app/optimizer/*.ts` for `Global.*` / game /
  `window` / `document` / `new Worker` imports finds runtime uses ONLY in `adapters.ts` (game-backed
  adapters) and `worker-pool-factory.ts` (`new Worker`). Every other optimizer module mentions
  `Global.*` only in comments asserting its own purity. Test-file mocks live only in `__tests__/`.

## Tasks landed

| Task | Summary | Acceptance criteria — verified how |
| --- | --- | --- |
| A1 | Confirm-replicate winner's-curse guard (`confirmSwaps`, default true) | `optimizer.test.ts` "confirm-replicate" block: spurious swap REJECTED on, ACCEPTED off; improving dim costs exactly one extra eval; commits with the replicate score. **PASS** |
| A2 | `minRelImprovement` relative floor; margin is `max`, not sum | `optimizer.test.ts` "relative-improvement floor (A2)": 1% rejected @0.02, 3% accepted, MAX-not-sum with the significance band. **PASS** |
| A3 | `bestFeasible` re-check at final fidelity | `optimizer.test.ts` "feasibility re-check (A3)": deathless-at-search/dies-at-final ⇒ `bestFeasible false`, `status completed`. **PASS** |
| A4 | Successive-halving rung ladder | `optimizer.test.ts` "successive-halving ladder (A4)": exact eval-count on 30 candidates; optimum survives; ladder skipped when ≤screenKeep; single-rung when 3·screenTrials≥searchTrials. **PASS** |
| A5 | `stdError` fields flow through | `optimizer.test.ts` "uncertainty surfaced (A5)": populated when the scorer supplies it, undefined otherwise. **PASS** |
| A6 | `multiStart` progress/event passthrough | `multistart.test.ts` (9 tests): events from every seed arrive; seed progress unchanged. **PASS** |
| B1 | `attackSpeed` lower-is-better in dominance prune | `prune.test.ts` (19) + `adapters-contract.test.ts` B1 regression: fast-weak & slow-strong both survive; strictly-worse-incl-slower pruned; damage-type-suffixed key handled; no other stat's direction changed. **PASS** |
| B2 | `simulateManySettled` per-request error capture + pool cancel/terminate | `worker-pool.test.ts` (9): 1-of-5 failing request isolated (`ok:false`), other 4 resolve in order; `cancel()`/`terminate()` fan-out. **PASS** |
| B3 | Slayer-task evaluation through the pool | Plumbing verified by `worker-pool.test.ts` `simulateManySettled`; the dispatch lives in `GameScorer.evaluateSlayerTask`. In-game speedup → morning checklist. **PASS (code); in-game speedup deferred** |
| B4 | Attack-style dimension | Implemented (`attackStyleDimension`, wired behind `attackStyle ?? true`); built entirely from `Global.*` so no headless test (like the other spell/agility dims). Build+tests green. In-game confirm → morning checklist. **PASS (code); in-game deferred** |
| C1 | PageController callback unsubscribed in `disconnectedCallback` | Code-inspection confirmed in `auto-optimize.ts`. **PASS** |
| C2 | Pool-init failure sets status text | Confirmed: `_ensurePool` catch sets "Sim worker pool failed to start — continuing with 1 worker." **PASS** |
| C3 | No NaN/Infinity label; bar hits 100% only on done | Code-inspection: progress guards + per-pass denominator rescaling present. **PASS (code)** |
| C4 | Results panel: ±SE, honest title, feasibility warning, survival caption, ≈ marker | Code-inspection of the results renderer. **PASS (code)** |
| C5 | Restarts wiring; `restarts===1` stays on the direct path | Confirmed in `auto-optimize.ts`: `restarts === 1` calls `optimizer.run` directly, else `multiStart`. Cancel/restore → morning checklist. **PASS (code)** |
| D | 25 adapter contract tests; mocks in test file only | `adapters-contract.test.ts` (25 tests green); purity intact. **PASS** |
| E1 | Docs refresh (both design docs) | This workstream — see below. **DONE** |
| E2 | Final integration pass | This section. **DONE** |

## Tasks skipped / deferred (with reasons)

- **A2b analytic pre-rank as default / candidate ordering (§2f):** never built — deprioritized in
  favor of the successive-halving ladder, which delivers most of the same benefit. Documented as NOT
  built in `auto-optimize-search.md` §2f.
- **D scope item 4 (`foodSignature`/`combatPotionIds` shaping):** stopped-and-logged by Workstream D
  (module-private; stubbing cost outweighs the marginal coverage — the dedupe core is already covered
  by `dedupe.test.ts`). See the Workstream D note below.
- **Genetic algorithm, per-slot marginal-contribution reporting, time/eval budget:** never built;
  now documented as NOT built in `auto-optimize.md` §4/§6. Simulated annealing IS built + tested but
  intentionally NOT wired (experimental; superseded by multi-start + compound summon dimension).
- Nothing was reverted during Waves 1–2; no E-owned task hit the two-attempt fail rule.

## E1 — doc changes made

`docs/auto-optimize-search.md`:
- §0: corrected the two false claims — the analytic surrogate's deriver IS built and wired (off by
  default, `preRankTopK 0`, nominal-target design), and the worker pool IS wired + auto-sized.
- §1a: marked multi-start WIRED (Restarts control, seed construction, `restarts===1` byte-identical).
- §1b(i): corrected summon-synergy to default ON + ADDITIVE (per-slot dims still searched;
  `includeSingles:false`). §1b(ii): annealing BUILT+TESTED, NOT WIRED (experimental, superseded).
- §2b: marked the deriver DONE and described the shipped nominal-target design; default off.
- §2d: marked the pool wiring DONE (auto-size, `evaluateBatch`, `simulateManySettled`, slayer path).
- §2e: noted the successive-halving ladder (A4) and that the UI enables screening by default via
  `fastSearch` (default true → `screenTrials = max(10, ⌊searchTrials/4⌋)`).
- §2f: marked NOT implemented.
- Added the **Theme 3 — Statistical rigor (§ significance)** section `types.ts` cites: batch-means
  stdError from `GameScorer(batches=5)`, the `significanceZ` gate, the `minRelImprovement` floor
  (A2), confirm-replicate (A1), and the slayer-task no-stdError caveat.

`docs/auto-optimize.md`:
- §3: item-pool row now tri-state (owned/craftable/all); added Targets (slayer-task averaging) and
  Attack-type-constraint + auto-ammo-fit rows.
- §4: rewrote the two-tier story — the FULL SIM scores the whole search; the analytic surrogate is a
  per-slot pre-FILTER (off by default), not the broad scorer. Marked GA, marginal-contribution
  reporting, and the time/eval budget as NOT built; documented the staged agility/cartography pass.
- §6: updated P1–P4 status to reflect what actually landed.

## Morning manual checklist (human-only — agents can't run the live game)

- In-game: run a search vs a mid-tier monster at 1 worker and at auto workers; compare wall-clock and
  confirm identical (or noise-tied) recommendations.
- In-game: slayer-task target with pool — confirm B3 speedup and sane results.
- In-game: `restarts: 3` run — confirm seeds show in status, cancel mid-seed restores gear.
- Verify Apply installs the recommended setup and the `bestFeasible === false` warning path (pick a
  barely-survivable target).
- Ammo edge: search with a ranged build, quantity-1 ammo equips — confirm ranged sims don't run dry
  (flagged as unverified in review).
- B4: optimize a melee build and confirm stab/slash/block are searched and the best style applied.

---

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
