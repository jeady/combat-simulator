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

### 1a. Cold-start bias
Pass 1 decisions are made against the user's *current* gear in all other slots. A bad early commit
can trap the search in a poor basin; extra passes only partly heal it.
- **Fix:** multi-start / random restarts. Seed starts from: (i) current setup, (ii) best single
  item per slot by analytic score, (iii) empty. Run coordinate ascent from each; keep the best
  feasible basin. Configurable restart count.

### 1b. Set-bonus & synergy blindness (the core limitation)
Coordinate ascent mutates ONE dimension at a time. Items good only *together* — armor set bonuses,
summon-familiar synergies, weapon+ammo+style+spell packages — are invisible: each piece alone scores
worse, so it is never adopted.
- **Fix (i): compound moves.** Detect coupled groups and add moves that swap a whole group at once
  (e.g. full set, or summon-pair). Add these as extra "dimensions" whose candidates are group tuples.
- **Fix (ii): annealing/GA polish.** After coordinate ascent converges, optionally run a small
  simulated-annealing or genetic pass seeded from the incumbent to cross set-bonus ridges.
  (Flagged in project notes as the intended mechanism for set synergies.)

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

### 2d. Parallel worker pool
Base mod has ONE worker (sequential candidates). Spin up our own pool of N workers and evaluate a
slot's candidate sweep concurrently (near-linear speedup). Biggest raw-throughput lever, most code.
Combine with the cache (2c) for dedup across workers.

### 2e. Adaptive trials / early statistical stop
Start each candidate at low trials; escalate trials only for candidates statistically close to the
incumbent (sequential test). Clear losers die after a handful of trials. Complements 2a (deaths) by
also early-killing clear metric losers.

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
