# Auto-Optimize: Search Correctness & Performance Plan

Status: living doc (updated 2026-07-02). Companion to `docs/auto-optimize.md` (architecture/seams).
Scope: make the optimizer (a) search the *right* space — the joint combination of all
slots/dimensions — and (b) do so fast enough to be usable. Most of this doc has now LANDED (see the
per-section ✅/◑/✗ status markers); the annealing polish (1b(ii)) and candidate ordering (2f) are
the notable not-wired / not-built items.

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
  (modifiers/enemyModifiers/conditionalModifiers/specialAttacks/combatEffects). Lower-is-better keys
  (attackSpeed) are projected onto a uniform higher-is-better axis before the prune
  (`directStatsForDominance`) so a slower-but-otherwise-equal weapon is never wrongly dropped.
- **Two-tier fidelity:** `searchTrials/searchTicks` during the sweep, `finalTrials/finalTicks` to
  re-score the winner.
- **Death-as-hard-constraint:** `optimizer.better()` makes `feasible` (deathRate ≤ threshold)
  dominate the metric; infeasible setups are compared by who is closer to surviving.

Analytic DPS surrogate (`analytic-scorer.ts`): the pure core AND the game-backed pre-rank deriver
are both built. `deriveCombatStats` + `makeGameScoreItem` (`adapters.ts`) equip a candidate on the
current background, recompute stats, and score it against a fixed nominal target (`PRERANK_TARGET =
{ hitpoints: 1, evasion: 1e9 }`, which reduces the surrogate to a monotonic gear-quality proxy).
It is a per-slot pre-FILTER, wired through `PreRankingCandidateProvider` and gated by
`preRankTopK` — which defaults to **0 (off)**; the UI prefers `fastSearch` low-trial screening as
the safer narrowing mechanism. So the surrogate is built and wired but off by default, NOT unused.

Worker pool: WIRED and auto-sized. `auto-optimize.ts` builds a `WorkerPool` (via
`createWorkerPool`) sized to `min(cores-1, 12)` from `navigator.hardwareConcurrency` (1 on ≤2
cores = the serial path), reused across runs. `GameScorer(batches, minTrialsPerBatch, pool)`
exposes the parallel `evaluateBatch` when a pool is present; the optimizer fans a dimension's
candidates across it. The single-worker `Simulator` path still exists and is used pool-less.

---

## Theme 1 — Searching the right thing (search quality)

### 1a. Cold-start bias  ✅ IMPLEMENTED + WIRED (2026-06-29; wired 2026-07-01)
**Landed** as `multistart.ts` `multiStart(optimizer, applier, scorer, target, seeds, …)`: runs the
optimizer from each seed (opaque `applier.snapshot()` tokens the caller supplies) and returns the best
via a local feasibility-first compare (mirrors `optimizer.better`), restoring the original setup after.
8 tests incl. a coupled-slot local-optimum trap that single-start can't escape. Caveat: the optimizer
could SWAP but not UNEQUIP — now fixed (see below), which also widens the reachable basins.
**WIRED into the UI:** the "Restarts: 1/3/5" control (`optimizer.store.restarts`, default 1) drives
seed construction in `auto-optimize.ts` (`current` + `random-i` seeds from a seeded mulberry32 over
the unlocked dimensions) and the `multiStart(...)` call. `restarts === 1` deliberately calls
`optimizer.run` directly (byte-identical to the pre-multistart path), so the extra machinery is only
engaged when the user asks for restarts.

### Empty/unequip candidate (from the 1a caveat)  ✅ IMPLEMENTED (2026-07-01)
`LoadoutApplier.unequip(slotId)` + an opt-in `includeEmpty` on `equipmentDimensions` that offers
`null` (unequip) as a candidate; `buildDimensions` `allowEmpty` (default true for the game). Lets the
search leave a slot empty when that beats every item (a net-negative item, or freeing a coupled slot)
— the sim decides. Opt-in keeps existing evaluation-count assertions unchanged.

### 1b. Set-bonus & synergy blindness (the core limitation)  ✅ IMPLEMENTED (2026-06-29 + 07-01)
- **Fix (i) — declared compound moves DONE + WIRED:** `synergy.ts` (pure `enumerateSummonChoices`) +
  `summonSynergyDimension` (reads `game.summoning.synergies`) — a compound dimension over BOTH summon
  slots so declared familiar PAIRS are adopted as one move. Behind `summonSynergy`, which defaults
  **ON**. It is **ADDITIVE**: the two per-slot summon dimensions are ALWAYS searched (never excluded)
  and optimally handle solos + additive non-synergy pairs; the compound dimension only ADDS what they
  can't reach — the empty baseline and the declared synergy pairs (`enumerateSummonChoices(pairs,
  ids, /*includeSingles=*/false)`). Cost is ~one extra evaluation per declared pair. The judgment
  rule: read DECLARED synergies from data, never heuristic-guess.
- **Fix (ii) — annealing polish for EMERGENT synergy: BUILT + TESTED, NOT WIRED (experimental):**
  `annealing.ts` `simulatedAnnealing(…)`: multi-dimension moves with feasibility-HARD / metric-SOFT
  (Metropolis) acceptance, seeded from a setup, to cross ridges coordinate ascent can't. 5 tests
  incl. an emergent pair that single-move search misses but annealing finds. The simulator is the
  judge — no heuristic synergy detection. It is **not imported by the UI** — superseded in priority
  by multi-start (1a, wired) + the compound summon dimension (fix (i), wired), which together cover
  the synergy cases that motivated it. Left in the tree as an experimental option to wire later.

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

### 2b. Analytic two-tier pre-rank  ✅ IMPLEMENTED (pure core 2026-06-29; deriver 2026-07-01)
Rank a slot's surviving candidates by the closed-form DPS surrogate (`analytic-scorer.ts`), full-sim
only the top-K. Turns "full-sim every owned item" into "full-sim the few that could win."
- **Done (`optimizer/prerank.ts`):** `selectTopK` + `PreRankingCandidateProvider` — wraps the
  existing `CandidateProvider`, narrows each slot to top-K by an **injected** `scoreItem` score.
  Chosen as a provider wrapper specifically so it needs **no `optimizer.ts` change** (avoids the
  other session's event-code contention). Pure + 11 unit tests. Slots with ≤K pass through; current
  item always retained; K configurable (≤0 disables). HEURISTIC (unlike `prune.ts`): too-small K can
  drop the optimum, hence configurable K.
- **Done — deriver (`adapters.ts`):** `makeGameScoreItem(applier)` returns a
  `scoreItem(slotId, itemId)`: snapshot → equip the candidate on the current background →
  `Global.game.combat.computeAllStats()` (required because the app equip path uses
  `isImporting=true`, which SKIPS the stat recompute) → `deriveCombatStats` reads
  `player.stats.{maxHit,minHit,accuracy,attackInterval}` → `estimateMetric` → restore. Returns NaN
  (sorted last) on failure. **Nominal-target design (what actually shipped):** rather than derive
  real per-attack-type enemy evasion, every candidate is scored against a FIXED nominal target
  `PRERANK_TARGET = { hitpoints: 1, evasion: 1e9 }`. Since pre-ranking only orders candidates
  against EACH OTHER and they all face the same real target, the target is a common factor that
  can't change the order; the high nominal evasion collapses the surrogate to a clean monotonic
  `accuracy × avgDamage ÷ interval` gear-quality proxy. This sidesteps the accuracy/evasion-by-
  attack-type mapping entirely — and it only ever FILTERS: the full sim scores the surviving top-K
  and has the final say, with K as the safety margin if the proxy misranks (e.g. a cross-damage-type
  swap). Wired via `buildDimensions({ preRankTopK })`.
- Configurable K. This is the generalized form of "skip obviously-worse tiers." Default `preRankTopK
  = 0` (**off**) in the UI — `fastSearch` (real low-trial screening, §2e) is preferred as the safer
  default narrowing mechanism.

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

### 2d. Parallel worker pool  ✅ IMPLEMENTED (core 2026-07-01; wired 2026-07-01)
- **Done:** `parallel.ts` `parallelMap` (pure bounded-concurrency scheduler, ≤N in flight, input
  order; 8 tests) and `worker-pool.ts` `WorkerPool` (owns N `SimulatorLike` workers, batch-dispatches
  via `parallelMap`, claim/return idle worker per task; tests with fakes — concurrency ≤ size, work
  spreads, order preserved; plus `simulateManySettled` per-request error capture and cancel/terminate
  coverage). `worker-pool-factory.ts` `createWorkerPool(size)` news the real N Workers (separate file
  so `worker-pool.ts` imports no browser globals → stays headless-testable).
- **Done — wired (`auto-optimize.ts` + `adapters.ts`):** the UI builds/reuses a pool auto-sized to
  `min(cores-1, 12)` (no user knob — see the module comment on why) and passes it to
  `GameScorer(5, 5, pool)`. With a pool present the scorer exposes `evaluateBatch`; the optimizer
  detects the method and fans a dimension's candidates across the pool (`runBatch`: import each setup
  + generate its save string on the main thread — cheap, serial — then sim all save strings
  concurrently). Per-request failures map to a NaN/infeasible evaluation for that candidate only
  (via `simulateManySettled`), never failing the whole batch. Slayer-task targets also dispatch
  their per-monster sims through the pool (B3). The single-worker path is untouched (additive): a
  pool-less `GameScorer` advertises no `evaluateBatch` and stays serial. Actual N-worker speedup is
  measured in-game (can't be verified headless — the harness sims in-process, no browser `Worker`).

### 2e. Adaptive trials / early statistical stop  ✅ IMPLEMENTED (2026-07-01; ladder 2026-07-02)
**Landed** as `screenTrials`/`screenKeep` in `OptimizeOptions` + an adaptive pass in the optimizer's
per-slot loop. As of the remediation (A4) this is a **successive-halving ladder**, not a single
screen: candidates race over rungs of rising fidelity — start at `screenTrials`, TRIPLE the trials
each rung, and after every rung keep the top `max(screenKeep, ⌈k/3⌉)` survivors — then confirm the
survivors at full `searchTrials`. It stops adding rungs once it's down to the confirm width or the
next rung would meet/exceed `searchTrials` (so `3·screenTrials ≥ searchTrials` degenerates to the old
single screen→confirm, and candidates ≤ `screenKeep` skip the ladder entirely). Opt-in (`screenTrials`
0 = off); only engages when a slot has > `screenKeep` candidates and `screenTrials < searchTrials`.
Each rung gets its own sound death-abort threshold; composes with pre-ranking (races the top-K set)
and the cache. Tests: exact eval-count accounting on a 30-candidate dimension; the known optimum
survives the ladder; ladder skipped when candidates ≤ screenKeep; single-rung when 3·screenTrials ≥
searchTrials. **The UI enables this by default:** `fastSearch` (`optimizer.store`, default **true**)
sets `screenTrials = max(10, ⌊searchTrials/4⌋)` (and `screenKeep = 3`); with `fastSearch` off,
`screenTrials = 0` and every candidate is evaluated once at full `searchTrials`.

### 2f. Candidate ordering  ✗ NOT IMPLEMENTED
Order each slot's candidates by analytic score so the strongest is simmed first → stronger incumbent
sooner → more candidates fall to pruning/early-stop. Not built: candidate ordering within a
dimension is unspecified (the provider returns ids in item-registry order, minus pruned/deduped
entries). The successive-halving ladder (2e) already delivers most of the "spend sims on the
plausible winners" benefit this was meant to buy, so it was deprioritized. The analytic surrogate
IS used to FILTER (top-K pre-rank, 2b) but not to order the candidates handed to the sim.

---

## Theme 3 — Statistical rigor (§ significance)

The metric is a Monte-Carlo estimate, so a candidate can "beat" the incumbent by sampling luck. A
dimension evaluates dozens of noisy candidates and takes the best, and max-of-N selection biases the
winner's estimate high — so without guards the search chases noise and recommends non-improvements.
Four composing guards (all landed in Wave 1, tracked here as the section `types.ts` cites):

- **Batch-means standard error.** `GameScorer` is constructed with `batches = 5` (min
  `minTrialsPerBatch = 5` trials/batch): each evaluation splits its trials into that many
  independent sub-runs **inside one worker call** (the heavy save decode is paid once per
  evaluation, not once per sub-run). `foldBatches` reports the metric as the mean of the per-batch
  plotted values and the batch-means `stdError` (`meanStdError` in `statistics.ts`). `stdError` is
  `undefined` for a single batch (too few trials to split), and it flows through
  `Evaluation.stdError` → `OptimizeEvent.stdError` and onto the result as `baselineStdError` /
  `bestStdError`.

- **Significance gate (`significanceZ`, default 1.645).** In `optimizer.better()` a swap is accepted
  only if `a.value > b.value + max(minImprovement, minRelImprovement·|incumbent|, significanceZ ·
  hypot(seA, seB))`. The margin is the **MAX of the three terms, not the sum**. The significance
  term is the one-sided normal band on the difference of two independent estimates (1.645 ≈ 95%
  one-sided; 1.0 ≈ 84%; 0 disables). It only bites when the scorer supplies `stdError`; otherwise it
  contributes 0 and the search falls back to the fixed/relative margins.

- **Relative-improvement floor (`minRelImprovement`, A2).** A noise floor for scorers that can't
  estimate `stdError`: require the gain to be at least this fraction of `|incumbent value|`. Folded
  into the same `max(...)` margin above (so 1% is rejected at `minRelImprovement 0.02` while 3% is
  accepted).

- **Confirm-replicate winner's-curse guard (`confirmSwaps`, default true, A1).** After a dimension
  picks its best candidate, if `confirmSwaps` is on and the scorer supports `evaluateFresh`, the
  optimizer re-simulates the proposed winner ONCE more (a fresh, cache-overwriting replicate) and
  commits only if the REPLICATE still clears the accept margin — and commits with the replicate's
  unbiased score, not the lucky sample. Costs exactly one extra evaluation per accepted improving
  swap. This removes the max-of-N selection bias that the significance band alone can't.

**Slayer-task/dungeon aggregates:** with a worker pool, `evaluateAggregate` batches each monster's
trials into sub-runs and folds batch *j* across all monsters into one independent aggregate sample —
so these targets DO supply a batch-means `stdError` and the significance gate applies. Historical
caveat: this path originally ran unbatched (no `stdError`, gate inert), which let metric-plateau
slots swap on pure noise; the pool-less serial path still behaves that way and falls back to the
fixed/relative `minImprovement` margins (the UI sets `minRelImprovement: 0.01` for these targets as
a backstop).

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
