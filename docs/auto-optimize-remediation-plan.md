# Auto-Optimize Remediation Plan (delegable, parallel)

Status: ready to execute (2026-07-01). Source: independent code review of the `auto-optimize`
branch (HEAD `23af7bf`, 156/156 tests green). This plan is **self-contained**: every task
carries the context, exact file locations, change spec, tests, and acceptance criteria an
implementing agent needs without access to the review conversation.

---

## 0. Orchestration instructions (read first)

**Who runs this:** one orchestrator agent, spawning one implementation agent per WORKSTREAM
(not per task). Tasks inside a workstream are SEQUENTIAL (they touch the same files); the
workstreams inside a wave run in PARALLEL (their file sets are disjoint — see the ownership
table). Do not start a wave until the previous wave's gate passes.

**Ground rules for every agent (paste into each agent's prompt):**

1. Repo: `C:\Users\jmead\Melvor Simulator\combat-simulator`, branch `auto-optimize`. Work
   directly on this branch. **Never open a pull request. Never push.** Commit after each
   completed task with a message in the existing style (`Auto-optimize: <what changed>`).
2. Touch ONLY the files your workstream owns (table below). If you believe you must edit a
   file owned by another workstream, STOP that task, log why in
   `docs/remediation-log.md`, and move on.
3. Preserve the purity boundary: no `Global.*` / game / `window` / `document` imports in any
   `src/app/optimizer/*.ts` file except `adapters.ts` and `worker-pool-factory.ts`.
4. Every engine-behavior change needs a headless vitest test in
   `src/app/optimizer/__tests__/`. Match the existing test style (fakes from
   `__tests__/fakes.ts`, seeded RNG, no snapshots, exact eval-count assertions where
   relevant).
5. Gate after every task: `npm test` fully green AND `npm run build` clean (no new type
   errors). If a task can't be made green after two fix attempts, `git checkout -- .` the
   task's changes, record the failure + diagnosis in `docs/remediation-log.md`, and continue
   with the next task. Never leave the branch red between commits.
6. Match surrounding code style and comment density. Comments explain constraints/WHY, not
   what the next line does.
7. Do not change the base Simulate page's behavior. Existing defaults may only change where a
   task explicitly says so.

**Wave plan:**

| Wave | Workstreams (parallel) | Gate |
| --- | --- | --- |
| 1 | A (engine), B (adapters/pruning), C-1 (UI independent) | `npm test` + `npm run build` green; each workstream's acceptance criteria met |
| 2 | C-2 (UI dependent on A), D (contract tests) | same |
| 3 | E (docs + integration verification) — single agent | same + final checklist |

**File ownership (per wave-1/2 workstream — no overlaps):**

| Workstream | Owns |
| --- | --- |
| A | `src/app/optimizer/types.ts`, `optimizer.ts`, `multistart.ts`, `cache.ts`, `statistics.ts`, `__tests__/optimizer.test.ts`, `__tests__/multistart.test.ts`, `__tests__/cache.test.ts`, `__tests__/fakes.ts` |
| B | `src/app/optimizer/prune.ts`, `adapters.ts`, `worker-pool.ts`, `parallel.ts`, `__tests__/prune.test.ts`, `__tests__/worker-pool.test.ts`, `__tests__/parallel.test.ts` |
| C-1 / C-2 | `src/app/user-interface/pages/auto-optimize/*` , `src/app/stores/optimizer.store.ts` |
| D | new file `src/app/optimizer/__tests__/adapters-contract.test.ts` only |
| E | `docs/auto-optimize.md`, `docs/auto-optimize-search.md`, `docs/remediation-log.md` |

---

## Wave 1 — Workstream A: engine statistics & search quality

One agent, tasks in this order (they all touch `optimizer.ts`).

### A1. Confirm-replicate before committing a swap (winner's-curse fix) — HIGH

**Context.** `CoordinateAscentOptimizer` accepts the best of N noisy candidate evaluations if
it beats the incumbent by `z·hypot(seA, seB)` (`optimizer.ts:212`, `:309-318`). Max-of-N
selection makes the winner's estimate biased high; with dozens of candidates per dimension,
spurious swaps are expected every run. Worse, `MemoizingScorer` (`cache.ts`) deliberately
serves ONE sample per setup key forever, so a lucky roll is frozen as the incumbent's score
for the rest of the search.

**Change.**
- `types.ts`: add to `Scorer` an optional method
  `evaluateFresh?(target, trials, ticks, deathAbortThreshold?): Promise<Evaluation>` with a
  doc comment: "Like evaluate, but must bypass any memoization and run a genuinely fresh
  simulation; implementations backed by a cache must overwrite the cached entry with the
  fresh result."
- `cache.ts` (`MemoizingScorer`): implement `evaluateFresh` — skip lookup, call
  `inner.evaluate`, `cache.set(key, evaluation)` (overwrite), count as a miss.
- `types.ts`: add `confirmSwaps: boolean` to `OptimizeOptions`, **default `true`**, doc
  comment explaining the winner's-curse rationale.
- `optimizer.ts`: in the commit block (`:223-237`), when `confirmSwaps` is on, the scorer has
  `evaluateFresh`, AND the winning choice differs from current: apply `bestChoice` on the
  incumbent, call `evaluateFresh(target, searchTrials, searchTicks, searchAbortThreshold)`,
  bump `evaluations`, emit an `'evaluated'` event for it. Accept the commit only if the
  replicate's score still satisfies `better(replicateScore, bestScore, minImprovement,
  significanceZ)` against the incumbent's score. On acceptance, commit with the REPLICATE's
  score as the new `bestScore` (not the original lucky sample). On rejection, keep the
  incumbent unchanged (do not try the runner-up).
- When the scorer lacks `evaluateFresh`, behave exactly as before (no extra eval).

**Tests** (`optimizer.test.ts` + extend `fakes.ts`):
- A scorer whose first evaluation of a specific setup returns an inflated metric and whose
  subsequent evaluations return the true (lower) value: assert the spurious swap is
  REJECTED with `confirmSwaps: true` and ACCEPTED with `confirmSwaps: false`.
- Eval-count assertion: an improving dimension costs exactly one extra evaluation.
- Existing eval-count tests will shift where swaps commit — update them deliberately, with a
  comment noting the +1-per-committed-swap accounting.
- `cache.test.ts`: `evaluateFresh` bypasses and overwrites; subsequent `evaluate` returns the
  fresh value.

**Acceptance:** all above green; default-path behavior only differs by the confirm replicate.

### A2. Relative-improvement floor when stdError is missing — MEDIUM

**Context.** For slayer-task targets `GameScorer` runs unbatched, so `stdError` is undefined
and the accept margin degrades to `max(minImprovement=0, z·0) = 0` — any noise-level delta
commits a swap.

**Change.**
- `types.ts`: add `minRelImprovement: number` to `OptimizeOptions`, default `0`. Doc: "Require
  the directed metric to improve by at least this FRACTION of the incumbent's value (a noise
  floor for scorers that can't estimate stdError). The accept margin is
  max(minImprovement, minRelImprovement·|incumbent|, z·hypot(seA, seB))."
- `optimizer.ts` `better()`: extend the margin exactly as documented (`|b.value|` as the
  base; guard `b.value === -Infinity` → treat relative term as 0). Thread the option through
  the two `better(...)` call sites (accept test and screen sort — screen sort keeps margin 0
  as today).

**Tests:** both directions: a 1% gain rejected at `minRelImprovement: 0.02`, a 3% gain
accepted; interaction with significance margin (max, not sum).

### A3. Feasibility re-check at final fidelity — MEDIUM

**Context.** The winner is feasible at `searchTrials` (e.g. 0 deaths in 200 ⇒ true death rate
could be ~1%), but the 1000-trial finalize (`optimizer.ts:250`) can reveal deaths and nothing
reacts — the result is still `completed/improved` and appliable.

**Change.**
- `types.ts`: add `bestFeasible: boolean` to `OptimizeResult` ("true iff the final full-
  fidelity re-score satisfies the death-rate threshold; false means the recommendation
  violates the survival constraint at higher fidelity").
- `optimizer.ts`: compute it from `finalEval` (`success && deathRate <= deathRateThreshold`).
  Do NOT change `improved` semantics.

**Tests:** a fake scorer that is deathless at search trials but reports deaths at final
trials ⇒ `bestFeasible === false`, `status === 'completed'`.

### A4. Generalize screen→confirm into successive halving — MEDIUM (perf)

**Context.** `screenTrials/screenKeep` (`optimizer.ts:187-204`) is a 2-rung racing scheme.
Late-game dimensions (the prayer dimension enumerates 1 + n + all same-family pairs — easily
150+ candidates) dominate run cost; more rungs cut sims per slot ~2-3× further.

**Change** (keep the existing option names; extend semantics):
- When screening is active (same gating as today), run a rung ladder instead of one screen:
  rung trials `t₀ = screenTrials`, `tᵢ₊₁ = min(3·tᵢ, searchTrials)`; after each rung keep the
  top `max(screenKeep, ceil(k/3))` candidates by the same `better(…, 0)` ordering; stop the
  ladder when survivors ≤ `screenKeep` or the next rung would be ≥ `searchTrials`; then
  confirm survivors at `searchTrials` exactly as today.
- Per-rung death-abort threshold: `floor(deathRateThreshold · tᵢ) + 1` (mirror
  `screenAbortThreshold` derivation at `optimizer.ts:60-62`).
- All rung evaluations go through the existing `evalChoices` (so batching/pool/cache/events
  keep working unchanged).

**Tests:** exact eval-count accounting for a 30-candidate dimension (document the arithmetic
in the test); known optimum survives the ladder; ladder skipped when `candidates ≤
screenKeep`; single-rung behavior when `3·screenTrials ≥ searchTrials` matches the old
screen→confirm counts.

### A5. Surface uncertainty in results and events — LOW (enables C-2)

**Change.**
- `types.ts`: add optional `stdError?: number` to `OptimizeEvent`; add
  `baselineStdError?: number` and `bestStdError?: number` to `OptimizeResult`.
- `optimizer.ts`: populate the event field from each `Evaluation.stdError`; populate result
  fields from the baseline eval and `finalEval`.

**Tests:** fields flow through for a scorer that supplies stdError; absent when it doesn't.

### A6. `multiStart` event/progress passthrough — LOW (enables C-2's restart wiring)

**Change.** `multistart.ts`: add optional trailing params `onOptimizerProgress?:
ProgressCallback` and `onEvent?: EventCallback`, threaded into each `optimizer.run(target,
options, onOptimizerProgress, cancel, onEvent)` call (`multistart.ts:191`). No behavior
change otherwise.

**Tests:** events from every seed's run arrive; seed progress callback unchanged.

---

## Wave 1 — Workstream B: adapters & pruning correctness

One agent, tasks in this order.

### B1. Fix `attackSpeed` direction in dominance pruning — HIGH (correctness bug)

**Context.** `GameCandidateProvider.getCandidates` prunes stat-pure items over the union of
all stat keys present (`adapters.ts:494-495`) using `pruneDominated` (`prune.ts:85-94`),
which assumes every stat is higher-is-better. `attackSpeed` is an `equipmentStats` key where
HIGHER = SLOWER = WORSE (see the stat table at
`src/app/user-interface/pages/_parts/equipment/equipment-controller.ts:443`). A stat-pure
slow weapon that is ≥ a fast weapon on every bonus and has higher `attackSpeed` currently
"dominates" it — the faster (possibly optimal-DPS) weapon is discarded before any sim.

**Change.**
- `prune.ts`: add
  `export const LOWER_IS_BETTER_STAT_KEYS = new Set(['attackSpeed']);` and a pure helper
  `export function directStatsForDominance(stats: Record<string, number>): Record<string, number>`
  that returns a copy with lower-is-better keys negated (match by base key: a key of
  `attackSpeed` or prefix `attackSpeed:` — stat keys can be damage-type suffixed as
  `key:damageTypeId`, see `adapters.ts:512-519`). Doc comment: dominance assumes
  higher-is-better; negating flips the axis so a FASTER weapon is the dominant one.
- `adapters.ts:493-495`: build the `StatVector`s for `pruneDominated` from
  `directStatsForDominance(...)`. Keep `statSignature` dedupe on the RAW stats (dedupe only
  merges identical vectors, direction-agnostic — negating consistently would also be fine,
  but raw keeps the signature strings stable).

**Tests** (`prune.test.ts`):
- Fast-weak vs slow-strong weapon vectors (realistic values: `attackSpeed` 2200 vs 3200,
  strength 10 vs 50): BOTH survive after direction fix.
- Strictly-worse-including-slower item IS pruned.
- Damage-type-suffixed `attackSpeed:melvorD:Normal` handled.
- Regression comment naming the bug.

**Acceptance:** tests green; no other stat's direction changed.

### B2. Per-item error capture in the parallel batch path — MEDIUM

**Context.** `WorkerPool.simulateMany` uses `parallelMap`, which rejects on the FIRST `fn`
rejection (`parallel.ts:12`), so one failed worker request nukes an entire dimension's batch:
`GameScorer.runBatch` catches the rejection and returns all-NaN for every candidate
(`adapters.ts:396-399`).

**Change.**
- `worker-pool.ts`: add
  `simulateManySettled(requests): Promise<Array<{ ok: true; value: SimulateResponse } | { ok: false; error: unknown }>>`
  — same claim/return discipline, but each task catches its own error (worker still returned
  to `available` in the `finally`). Keep `simulateMany` as-is for compatibility.
- `adapters.ts` `runBatch`: use `simulateManySettled`; map `ok:false` entries to
  `{ metric: NaN, deathRate: Infinity, success: false }` and log ONE warning with the count
  and first error; `ok:true` entries fold exactly as before.

**Tests** (`worker-pool.test.ts`): a fake simulator where request #2 of 5 rejects — other 4
resolve in input order, pool never underflows, the failed slot is `ok:false`. Also add the
currently-missing coverage: `cancel()` fans out to every simulator; `terminate()` calls
`terminate?.()` on each.

### B3. Slayer-task evaluation through the worker pool — MEDIUM (perf)

**Context.** `GameScorer.evaluateSlayerTask` (`adapters.ts:223-268`) sims each task monster
serially even when a pool exists, and `runBatch` explicitly falls back to serial for slayer
targets (`adapters.ts:369`). A task with 8 monsters is ~8× per evaluation with the pool idle.

**Change.** In `evaluateSlayerTask`, when `this.pool` is present: generate the save string
ONCE (the setup is identical for every monster), build one `SimulateRequest` per monster
(`entityId: undefined`, `batches: undefined` — mirror the serial request shape at
`adapters.ts:288-298`), dispatch via `simulateManySettled` (from B2), convert each settled
result through `responseToDatas` and fold into `dataByMonster` exactly as the serial loop
does (failed → `newSimDataEntry(true)` placeholder). Serial path stays for pool-less scorers.
Leave `runBatch`'s slayer fallback as-is (candidates still serial; each candidate's monsters
now parallel).

**Tests:** headless testing needs `Global`; cover the settled-dispatch plumbing via B2's
tests and note "verify in-game: slayer-task run with 8 workers is ~Nx faster" in
`docs/remediation-log.md`.

### B4. Attack-style dimension — BEST-EFFORT (investigate, then implement or document)

**Context.** The design docs claim attack style is in scope; only an attack-TYPE filter
exists (`weapon-rules.ts:23-34`). Stab/slash/block (and ranged/magic style variants) are
never searched.

**Steps.**
1. Investigate how `Settings` (`src/app/settings-controller.ts`) stores the selected attack
   style(s). Look for fields like `attackStyle`/`styles` and how the config UI sets them.
2. If a plain Settings field exists: add an `attackStyleDimension()` in `adapters.ts` using
   the existing `settingsDimension` helper (`adapters.ts:775-803`) — candidates = the legal
   styles for the CURRENT weapon's attack type (re-read each pass, like the spell
   dimensions), described by name; wire into `buildDimensions` behind
   `options.attackStyle ?? true`.
3. If styles are NOT cleanly representable in Settings, do NOT hack it: write your findings
   (where style lives, what a future implementation needs) to `docs/remediation-log.md` and
   skip.

**Acceptance:** either a working dimension + build/test green, or a concrete findings entry.

---

## Wave 1 — Workstream C-1: independent UI fixes

One agent, tasks in this order. All in `src/app/user-interface/pages/auto-optimize/`.

### C1. Unsubscribe the `PageController` callback — LOW

`auto-optimize.ts:221-226` registers a callback via `PageController.on(...)` that is never
removed in `disconnectedCallback()` (which already exists and tears down the render timer /
pool). Store the callback reference; call the matching `off`/unsubscribe API in
`disconnectedCallback`. If `PageController` has no `off`, add one (it's app-owned code) or
guard the callback with an `isConnected` check — pick whichever is smaller.

### C2. Surface worker-pool init failure — LOW

`_ensurePool` (`auto-optimize.ts:757-772`) silently falls back to the single worker when
`pool.init()` throws. Set `this._status.textContent = 'Sim worker pool failed to start —
continuing with 1 worker.'` in the catch (the run then proceeds; keep the existing logging).

### C3. Honest progress/ETA — MEDIUM

**Context.** The ETA divides by an up-front estimate of total evals (candidates × maxPasses,
`auto-optimize.ts:784-796`). Early convergence, cache hits, and screening make this wrong in
both directions, and the comment claiming it "errs long" is not reliably true.

**Change.**
- Progress line: show what is actually known — `pass 2/≤3 · <dimension label> · 412 sims ·
  3.1 sims/s`. Keep the bar but cap displayed progress at 95% until `phase === 'done'`, and
  label the time as `~` (rough). After each completed pass, rescale the denominator to
  `evalsSoFar + remainingPassEstimate` (remaining passes may not run — hence `≤`).
- Fix the misleading comment.

**Acceptance:** no NaN/Infinity in the label at run start or with 0-candidate dimensions;
bar reaches 100% only on done/cancelled.

---

## Wave 2 — Workstream C-2: UI work dependent on Wave-1 A

Same UI agent (or a fresh one), AFTER workstream A has merged.

### C4. Show uncertainty and constraints honestly — MEDIUM

Uses A5's `baselineStdError`/`bestStdError`/`OptimizeEvent.stdError` and A3's `bestFeasible`.

- Results panel: `baseline 1,234 ± 56 /h → best 1,481 ± 61 /h` (omit `±` when stdError is
  undefined). Title the result "Best setup found (local search — not guaranteed optimal)".
- If `result.bestFeasible === false`: a prominent warning above Apply — "⚠ At full fidelity
  this setup died (death rate X%) despite surviving the search trials. Treat with caution."
  Apply stays enabled but the warning must be unmissable.
- Objective section: one caption line — `Survival constraint: no deaths tolerated
  (checked over ${searchTrials} search trials — a setup passing this can still have a true
  death rate up to ~${(3/searchTrials*100).toFixed(1)}%).`
- Leaderboard: entries whose directed metric is within `1.645·hypot(se_leader, se_entry)` of
  the leader get a `≈` marker with a title-tooltip "within simulation noise of #1" (skip when
  stdError missing).

### C5. Wire multi-start restarts — HIGH (the biggest search-quality win)

Uses A6's passthrough. **Context:** `multistart.ts` is fully built and tested but never
called from the app; production is single-start greedy from the user's current gear, which
its own test suite proves can be trapped (multistart.test.ts:57-74).

- `optimizer.store.ts`: add `restarts: number` (default `1` = today's behavior).
- `auto-optimize.html/.ts`: a small select "Restarts: 1 / 3 / 5" next to Fast search, with a
  title-tooltip "Re-run the search from N different starting loadouts and keep the best —
  escapes bad starting-gear traps at ~N× the time."
- Seed construction in `_onRun` when `restarts > 1` (all as `applier.snapshot()` tokens,
  restoring the user's setup between constructions):
  1. `current` — the user's setup as-is.
  2. `random-i` — for each remaining seed: for every UNLOCKED dimension, apply a uniformly
     random candidate (use a seeded mulberry32 RNG seeded from the run start time; skip
     dimensions with no candidates), snapshot. Conflict resolution is handled by the
     appliers, same as the search itself.
- Run `multiStart(optimizer, applier, scorer, target, seeds, runOptions, onSeedProgress,
  cancel, onOptimizerProgress, onEvent)`; use `result.best` where `_onRun` currently uses the
  single run's result (the progression pass and result rendering consume it unchanged —
  `MultiStartResult.best` is an `OptimizeResult`).
- Status line during seeds: `Restart 2/3 …`. The shared `MemoizingScorer` is constructed once
  per run and reused across seeds (big cache win — keep it that way).
- Estimated-evals for C3's display: multiply by seed count.

**Acceptance:** `restarts: 1` path is byte-identical to today (still calls `optimizer.run`
directly — do not route the 1-seed case through `multiStart`); a 3-restart run completes,
cancels cleanly mid-seed, and restores the user's setup.

---

## Wave 2 — Workstream D: adapter contract tests

New agent, new file `src/app/optimizer/__tests__/adapters-contract.test.ts` ONLY. Runs after
Wave 1 so it can regression-test B1.

**Context.** `adapters.ts` (~1,400 lines) carries all the game-coupled risk and has zero
tests. Full fidelity needs the running game, but the pure logic inside the adapter functions
can be tested by stubbing `Global` with `vi.mock('src/app/global', ...)`.

**Scope (best-effort, in priority order — stop where stubbing cost explodes and log):**
1. `GameCandidateProvider.getCandidates` with a stub `Global.game` exposing ~8 fixture items:
   filters by validSlots / equip requirements / pool (owned via stubbed
   `Global.melvor.stats.itemFindCount`) / attack-type constraint / ammo-vs-weapon coupling;
   special-effect items exempt from pruning; **B1 regression: a fast-weak weapon survives
   against a slow-strong one**.
2. `summonSynergyDimension`: candidates = empty + declared pairs whose members are available
   (stub `Global.game.summoning.synergies`); `applyChoice` clears both slots then equips;
   `equals` is order-insensitive.
3. `slayerTaskTargetId` / `isSupportedTarget` branches (stub `Lookup.isSlayerTask`).
4. `foodSignature`/`combatPotionIds` candidate shaping.

Explicitly out of scope: `GameLoadoutApplier` (needs real `SettingsController` round-trips —
in-game verification only), `GameScorer` sim paths.

**Acceptance:** new tests green without weakening the purity check (mocks live in the test
file only); a note in `docs/remediation-log.md` listing what remains in-game-verify-only.

---

## Wave 3 — Workstream E: docs refresh + integration verification

Single agent, LAST (so it documents what actually landed).

### E1. Fix stale/wrong claims in both design docs

In `docs/auto-optimize-search.md`:
- §0: "analytic surrogate built but NOT wired" and "single sequential worker only — no pool"
  are both false — pre-rank deriver exists (`adapters.ts:611-629`, scored against a nominal
  target `PRERANK_TARGET`, off by default via `preRankTopK: 0`) and the pool is wired and
  auto-sized (`auto-optimize.ts`).
- §1b(i): the summon-synergy dimension is **default ON and additive** (per-slot summon dims
  still searched; compound dim uses `includeSingles: false`) — the doc says default off +
  slots excluded.
- §1a/§1b(ii): mark multistart as WIRED (after C5) and annealing as **built, tested, NOT
  wired — experimental; superseded in priority by multi-start + compound dimensions**.
- §2b/§2d "pending" status lines: mark done, describe the nominal-target design actually
  shipped.
- §2e: note the UI enables screening by default via `fastSearch` and (after A4) uses a
  successive-halving ladder.
- Add the missing **"§ significance"** section that `types.ts:150` cites: batch-means
  stdError from `GameScorer(batches=5)` worker-side sub-runs, `significanceZ` gate,
  `minRelImprovement` floor (A2), confirm-replicate (A1), and the slayer-task no-stdError
  caveat.
- §2f candidate ordering: mark not implemented.

In `docs/auto-optimize.md`:
- §3/§4: correct the two-tier story (analytic surrogate is a per-slot pre-FILTER, not the
  broad-search scorer); mark GA, marginal-contribution reporting, and the time/eval budget
  as NOT built; document the `craftable` pool tier, slayer-task targets, attack-type
  constraint, auto-ammo-fit, and the staged agility/cartography pass.

### E2. Final integration pass

1. `npm test` and `npm run build` from clean checkout state.
2. Re-run every wave's acceptance criteria checklist; record pass/fail per task in
   `docs/remediation-log.md`.
3. Grep re-check of the purity boundary (rule 3) across `src/app/optimizer/`.
4. Produce a summary at the top of `docs/remediation-log.md`: tasks landed, tasks skipped
   (with reasons), and the **morning manual checklist** below, then commit.

**Morning manual checklist (for the human — agents cannot do these):**
- In-game: run a search vs a mid-tier monster at 1 worker and at auto workers; compare
  wall-clock and confirm identical (or noise-tied) recommendations.
- In-game: slayer-task target with pool — confirm B3 speedup and sane results.
- In-game: `restarts: 3` run — confirm seeds show in status, cancel mid-seed restores gear.
- Verify Apply installs the recommended setup and the `bestFeasible === false` warning path
  (pick a barely-survivable target).
- Ammo edge: search with a ranged build, quantity-1 ammo equips — confirm ranged sims don't
  run dry (flagged as unverified in review).

---

## Explicitly out of scope (do not attempt overnight)

- Wiring `annealing.ts` (kept as experimental; documented in E1).
- Common-random-numbers / seedable worker RNG (separate investigation; high value, high risk).
- GP/Drops/Pet objectives (`UNSUPPORTED_KEYS`).
- Any upstream merge or game-version bump.
