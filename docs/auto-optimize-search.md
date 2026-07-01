# Auto-Optimize: Search Correctness & Performance Plan

Status: planning doc (2026-06-29). Companion to `docs/auto-optimize.md` (architecture/seams).
Scope: make the optimizer (a) search the *right* space — the joint combination of all
slots/dimensions — and (b) do so fast enough to be usable. No code landed from this doc yet.

---

## 0. Current state (read this first — corrects a common misconception)

The optimizer is **already a joint search, not per-slot-in-isolation.**
`CoordinateAscentOptimizer` (`src/app/optimizer/optimizer.ts`) keeps an *incumbent full
loadout* (every equipment slot + food/consumable dimensions). When it tests a candidate for one
slot, `Scorer.evaluate()` simulates the **entire combination** — that candidate on top of the
current best of every other slot. It commits the per-slot winner, then sweeps all slots again for
up to `maxPasses` passes until a pass makes no improvement.

So each simulation already scores a full loadout. What we do NOT do is **exhaustively** enumerate
combinations (`~2200 items ^ ~13 slots` is impossible). Coordinate ascent is the tractable
approximation of joint optimization. Its weaknesses are specific and fixable (Theme 1).

Already implemented and relevant:
- **Dominance pruning** (`prune.ts`, wired in `GameCandidateProvider`): per slot, drops items that
  are Pareto-dominated on the relevant combat stats. This is the sound, general form of
  "Steel beats Bronze, skip Bronze." Never prunes items with special effects
  (modifiers/enemyModifiers/conditionalModifiers/specialAttacks/combatEffects).
- **Two-tier fidelity:** `searchTrials/searchTicks` during the sweep, `finalTrials/finalTicks` to
  re-score the winner.
- **Death-as-hard-constraint:** `optimizer.better()` makes `feasible` (deathRate ≤ threshold)
  dominate the metric; infeasible setups are compared by who is closer to surviving.

Built but NOT wired: the analytic DPS surrogate (`analytic-scorer.ts`).
Single sequential worker only (`Simulator` in `src/app/worker/simulator.ts`) — no pool.

---

## Theme 1 — Searching the right thing (search quality)

### 1a. Cold-start bias  ✅ IMPLEMENTED (2026-06-29)
**Landed** as `multistart.ts` `multiStart(optimizer, applier, scorer, target, seeds, …)`: runs the
optimizer from each seed (opaque `applier.snapshot()` tokens the caller supplies) and returns the best
via a local feasibility-first compare (mirrors `optimizer.better`), restoring the original setup after.
8 tests incl. a coupled-slot local-optimum trap that single-start can't escape. Caveat: the optimizer
could SWAP but not UNEQUIP — now fixed (see below), which also widens the reachable basins.

### Empty/unequip candidate (from the 1a caveat)  ✅ IMPLEMENTED (2026-07-01)
`LoadoutApplier.unequip(slotId)` + an opt-in `includeEmpty` on `equipmentDimensions` that offers
`null` (unequip) as a candidate; `buildDimensions` `allowEmpty` (default true for the game). Lets the
search leave a slot empty when that beats every item (a net-negative item, or freeing a coupled slot)
— the sim decides. Opt-in keeps existing evaluation-count assertions unchanged.

### 1b. Set-bonus & synergy blindness (the core limitation)  ✅ IMPLEMENTED (2026-06-29 + 07-01)
- **Fix (i) — declared compound moves DONE:** `synergy.ts` (pure `enumerateSummonChoices`) +
  `summonSynergyDimension` (reads `game.summoning.synergies`) — a compound dimension over BOTH summon
  slots so declared familiar PAIRS are adopted as one move. Behind `summonSynergy` (default off);
  excludes the summon slots from per-slot search when on. The judgment rule: read DECLARED synergies
  from data, never heuristic-guess.
- **Fix (ii) — annealing polish for EMERGENT synergy DONE:** `annealing.ts` `simulatedAnnealing(…)`:
  multi-dimension moves with feasibility-HARD / metric-SOFT (Metropolis) acceptance, seeded from a
  setup, to cross ridges coordinate ascent can't. 5 tests incl. an emergent pair that single-move
  search misses but annealing finds. The simulator is the judge — no heuristic synergy detection.

### 1c. Coupled-slot correctness
Candidate legality must update when a partner slot changes:
- 2H ↔ shield ↔ ammo (partly handled via re-snapshot after `applyChoice`).
- attack style ↔ damage type ↔ valid spells/curses/auroras.
- **Summon synergy re-validation** when a summon slot changes (`isSynergyUnlocked`) — flagged
  "critical" in project notes, not yet implemented.
- **Action:** each Dimension's `getCandidates()` must read live world state so it reflects the
  current partner choices; add explicit revalidation for style/spell/synergy gating.

### 1d. Constraint correctness (regression guard)
Add a focused test: a 0-death feasible setup must always beat a higher-metric setup that ever dies,
across maximize and minimize objectives. Lock the `better()` feasibility-dominates behavior.

---

## Theme 2 — Performance & heuristics (feasibility)

Ordered by ROI.

### 2a. Early-abort on death  ✅ IMPLEMENTED (2026-06-29)
**Landed.** `deathAbortThreshold` is plumbed `SimulateRequest` → app `Simulator.simulate` → worker
`main.ts` → `simulateMonster` → `SimManager.runTrials` (extra `&& deathCount < threshold` loop guard;
default `Infinity` = no abort, so the normal Simulate page is unchanged). The optimizer derives a
**sound** threshold and never aborts a setup that could still end feasible:
`searchAbortThreshold = earlyStopOnDeath ? floor(deathRateThreshold * searchTrials) + 1 : Infinity`
(so `deathRateThreshold 0` ⇒ abort on the 1st death; raising the tolerance raises the threshold).
The **final re-score never aborts**, so the reported death rate stays exact. New option
`earlyStopOnDeath` (default true) in `OptimizeOptions`. `Scorer.evaluate` gained an optional
`deathAbortThreshold`. Unit tests: feasibility-dominance (maximize+minimize) and threshold-derivation
wiring (1/derived/Infinity) in `optimizer.test.ts` (48 tests pass). Type-clean (no new `src/` tsc
errors); harness boots+runs unchanged (threshold inert there). **Follow-up:** a headless
dying-scenario check that asserts the run aborts early (tickCount ≪ trials*tickLimit) — not yet done.

Design note (original plan said "configurable threshold, default 1"): the configurable knob is the
existing `deathRateThreshold` *tolerance* (the abort point is derived from it soundly) plus the
`earlyStopOnDeath` on/off switch — preferred over a raw count because a raw count can be unsound when
the tolerance is > 0.

Historical reference:
`SimManager.runTrials()` (`src/shared/simulator/sim-manager.ts:~488`) runs the full `trials` loop.
Add: break as soon as `deathCount >= deathAbortThreshold` and mark the result infeasible. Because we
optimize for 0 deaths, a setup that dies is already infeasible — finishing the remaining trials is
wasted work. Large speedup on the (many) candidates that die.
- **Plumbing:** add `deathAbortThreshold?: number` to `SimulateRequest`
  (`src/shared/transport/type/simulate.ts`) → `Simulator.simulate` → worker → `runTrials`.
- **Default:** threshold = 1 (abort on first death). User-configurable; set to 0/disabled to keep
  full trials when a precise death rate is wanted even for infeasible setups.
- **Reporting:** when aborted early, deathRate is a lower bound, not exact — flag the result so the
  UI/optimizer treats it as "infeasible (aborted)" rather than a precise rate.

### 2b. Analytic two-tier pre-rank  ◑ PURE CORE DONE (2026-06-29); deriver pending
Rank a slot's surviving candidates by the closed-form DPS surrogate (`analytic-scorer.ts`), full-sim
only the top-K. Turns "full-sim every owned item" into "full-sim the few that could win."
- **Done (`optimizer/prerank.ts`):** `selectTopK` + `PreRankingCandidateProvider` — wraps the
  existing `CandidateProvider`, narrows each slot to top-K by an **injected** `scoreItem` score.
  Chosen as a provider wrapper specifically so it needs **no `optimizer.ts` change** (avoids the
  other session's event-code contention). Pure + 11 unit tests. Slots with ≤K pass through; current
  item always retained; K configurable (≤0 disables). HEURISTIC (unlike `prune.ts`): too-small K can
  drop the optimum, hence configurable K.
- **Pending (game-coupled, verification-heavy):** the `scoreItem` deriver — equip the candidate on
  the current background, recompute, read surrogate inputs. Key finding: `player.equipItem(...,
  isImporting=true)` SKIPS the stat recompute, so the deriver must call
  `player.manager.computeAllStats()` (or `updateForEquipmentChange()`) after equipping, then read
  `player.stats.{maxHit,minHit,accuracy,attackInterval}` and the target's hitpoints + the
  attack-type-correct evasion off the enemy. The accuracy/evasion-by-attack-type mapping needs
  in-game/harness verification (compare analytic top pick vs the full-sim winner) — best coordinated
  with the sim-verification session. This is the only remaining piece of 2b.
- Configurable K. This is the generalized form of "skip obviously-worse tiers."

### 2c. Memoization cache  ✅ IMPLEMENTED (2026-06-29)
**Landed** as `optimizer/cache.ts` `MemoizingScorer` — a `Scorer` **decorator** (zero changes to
`optimizer.ts`, so it doesn't conflict with the other session's event work). Keyed by
`setupKey() | monster | entity | trials | ticks | deathAbortThreshold`, where `setupKey` is injected
(reads the applied setup). `stableStringify` (also in cache.ts) is a Map/Set-aware serializer —
**required** because `Settings` holds several `Map`s and plain `JSON.stringify` renders a `Map` as
`{}`, collapsing every equipment-differing loadout into one colliding key (silent wrong results).
Including `trials`/`ticks` means the higher-fidelity final re-score never collides with a coarser
search entry. Wired into the app (`auto-optimize.ts`: fresh cache per run, key =
`stableStringify(applier.snapshot())`) and the headless harness (key = applied loadout map). Unit
tests: 11 in `cache.test.ts`. Headless-verified: an 8-evaluation run did **5 real sims + 3 cache
hits**, optimizer result unchanged. App wiring type-checked; warrants in-game confirmation.

Caveat (in cache.ts): sims are stochastic, so the cache memoizes ONE sample per key — deliberate
(stable estimate removes noise-driven flip-flopping; the final re-score still runs fresh).

### 2d. Parallel worker pool  ◑ CORE DONE (2026-07-01); game wiring pending
- **Done:** `parallel.ts` `parallelMap` (pure bounded-concurrency scheduler, ≤N in flight, input
  order; 8 tests) and `worker-pool.ts` `WorkerPool` (owns N `SimulatorLike` workers, batch-dispatches
  via `parallelMap`, claim/return idle worker per task; 6 tests with fakes — concurrency ≤ size, work
  spreads, order preserved). `worker-pool-factory.ts` `createWorkerPool(size)` news the real N Workers
  (separate file so `worker-pool.ts` imports no browser globals → stays headless-testable).
- **Pending (needs the running game):** wire the pool into the optimizer's per-slot candidate sweep
  (a batch evaluate: generate all candidate save strings in-process, dispatch across the pool), and
  measure the actual N-Worker speedup. Can't be verified headless — the harness sims in-process, no
  browser `Worker`. The existing single-worker path is untouched (additive).

### 2e. Adaptive trials / early statistical stop  ✅ IMPLEMENTED (2026-07-01)
**Landed** as `screenTrials`/`screenKeep` in `OptimizeOptions` + a screen→confirm pass in the
optimizer's per-slot loop: candidates are screened at `screenTrials` (low), then only the best
`screenKeep` are confirmed at full `searchTrials`. Opt-in (`screenTrials` 0 = off); only screens when
a slot has > `screenKeep` candidates and `screenTrials < searchTrials`. Screen evals get their own
sound death-abort threshold; composes with pre-ranking (screens the already-top-K set) and the cache.
Tests: finds the true optimum under screening; screens the losers cheaply while only `screenKeep`
reach full trials; no screen when candidates ≤ `screenKeep`.

### 2f. Candidate ordering
Order each slot's candidates by analytic score so the strongest is simmed first → stronger incumbent
sooner → more candidates fall to pruning/early-stop.

---

## Configurability (Auto-Optimize panel)

`OptimizeOptions` already has searchTrials/finalTrials/ticks/maxPasses/deathRateThreshold/
minImprovement. Add and expose:
- **Death abort:** on/off + threshold (default 1).
- **Pruning:** dominance on/off; analytic pre-rank top-K.
- **Search effort:** restart count; enable annealing/GA polish; max passes.
- **Item pool:** owned-only vs all (toggle already designed).
- **Parallelism:** worker count.
- **Presets:** Fast / Balanced / Thorough set the above as a group, with an "Advanced" expander for
  raw knobs.

---

## Suggested sequencing

1. **Quick wins:** death-abort (2a, configurable threshold) + constraint regression test (1d).
2. **Tractability:** analytic two-tier (2b) + memoization (2c) → makes all-items pools usable.
3. **Quality:** restarts (1a) + coupled/synergy moves & revalidation (1b/1c).
4. **Scale:** parallel workers (2d) + adaptive trials (2e) + candidate ordering (2f).
5. **Config UI + presets.**

---

## Test strategy

Each item is verifiable headless via `tools/headless-sim` (`npm run harness`) or vitest:
- 2a: harness run where a deliberately weak setup dies — assert sim aborts early (tick count well
  below `trials * tickLimit`) and is marked infeasible.
- 1d/1b: pure optimizer tests with fakes (feasibility dominance; a synthetic "set bonus" only the
  compound move can find).
- 2b/2f: assert top-K full-sims match the full-sweep winner on seeded fixtures.
- 2c: assert cache hit count > 0 and identical results with/without cache.
- Regression guard: equipment-only result stays identical with new toggles off.
