# Auto-Optimize — Design Document

> **Auto-Optimize** is a fork-local feature of the Myth Combat Simulator (Melvor Idle mod):
> given a combat target and an objective, it searches across gear, consumables, prayers,
> spells, attack style, summoning familiars, agility, and cartography to find the best
> loadout the character can field — instead of the player trying combinations by hand.

This is the standalone design document for the feature as **built and shipped** on the
`auto-optimize` branch. Planned-but-unbuilt work lives in `docs/auto-optimize-roadmap.md`.
The history of how the design evolved (the original plan, the search-correctness plan, and
the remediation record) is preserved in git history under the retired files
`auto-optimize.md`, `auto-optimize-search.md`, `auto-optimize-remediation-plan.md`, and
`remediation-log.md`.

---

## 1. Problem statement

The base mod evaluates **one** combat setup at a time: it runs the real game combat classes
(`Player`/`Enemy`/`CombatManager`) tick-by-tick inside a Web Worker for N trials and reports
averaged metrics (kills/hr, XP/hr, death rate, …). Finding the *best* setup is left to the
player.

Brute force is impossible: ~13 equipment slots × hundreds of items each, times prayers,
potions, food, spells, styles, and familiar pairs, is an astronomically large product.
Auto-optimize makes the search tractable with three ideas:

1. **Coordinate ascent** — optimize one *dimension* (slot/lever) at a time against the best
   known setting of every other dimension, and sweep repeatedly until nothing improves.
   Every evaluation scores a **full loadout**; what we avoid is exhaustively enumerating
   combinations.
2. **Aggressive, sound candidate pruning** — before any simulation runs, each dimension's
   candidate list is filtered and deduplicated so only items that could plausibly win are
   ever simmed.
3. **Fidelity laddering** — cheap low-trial sims eliminate clear losers; full-trial sims
   confirm winners; a final high-fidelity re-score validates the recommendation. Speed comes
   from *fewer trials per candidate*, never from a cheaper scoring function: **the real
   stochastic simulator is the judge of every accepted decision.**

## 2. Design principles

These recur throughout the implementation and explain most non-obvious choices:

- **The simulator is the judge.** No heuristic ever decides an outcome. Analytic estimates
  and declared game data may *filter or propose* candidates, but every accept/reject
  decision is made on a real simulation result. (Corollary: read *declared* synergies from
  game data; never guess synergy heuristically.)
- **Survival is a hard constraint, not a metric.** A setup that dies more than the tolerance
  (default: zero deaths) can never beat one that survives, no matter its metric. Comparisons
  are feasibility-first at every level of the search.
- **Respect Monte-Carlo noise.** The metric is a noisy estimate; a search that takes the max
  of dozens of noisy samples per dimension will chase luck. Multiple statistical guards
  (§ 6) give the search a deliberate status-quo bias: a swap is only recommended when the
  improvement is statistically real.
- **Purity boundary for testability.** Everything in `src/app/optimizer/` is pure,
  dependency-injected search logic — no `Global.*`, game, `window`, or `document` imports —
  **except** `adapters.ts` (the game-backed implementations) and `worker-pool-factory.ts`
  (the only place that `new Worker`s). The engine runs headless under vitest with fakes;
  200+ tests cover it, including exact evaluation-count accounting.
- **Additive wiring, byte-identical defaults.** Optional machinery (multi-start, screening,
  pre-rank, the compound synergy dimension) is wired so that turning it off reproduces the
  simpler code path exactly. The base mod's Simulate page behavior is never changed.
- **Always restore.** The search mutates the simulated game world constantly; a `finally`
  restores the user's original setup on every exit path (done, cancelled, thrown).

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Auto-Optimize page (UI)                src/app/user-interface/pages/…      │
│  target/objective readout · scope grid · run/cancel · live feed ·          │
│  leaderboard · progress/ETA · results/warnings · Apply                     │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ builds and orchestrates
               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Search engine (pure, headless-testable)      src/app/optimizer/            │
│                                                                            │
│  CoordinateAscentOptimizer (optimizer.ts) ── the search loop (§5)          │
│      │ uses                                                                │
│      ├─ Dimension[] ──── one per searched lever (slots, prayers, food, …)  │
│      ├─ Scorer ────────── evaluate(loadout) → {metric, deathRate, stdErr}  │
│      └─ SetupApplier ──── snapshot/restore the whole combat setup          │
│                                                                            │
│  multistart.ts   restart the search from N seeds, keep the best            │
│  cache.ts        MemoizingScorer — dedupe repeat evaluations               │
│  prune.ts        dominance pruning (Pareto)     dedupe.ts   stat dedupe    │
│  prerank.ts      optional analytic top-K filter annealing.ts (unwired)     │
│  parallel.ts     bounded-concurrency scheduler  statistics.ts batch means  │
│  worker-pool.ts  N-worker dispatch (pure)                                  │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ game-backed implementations (the ONLY impure modules)
               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ adapters.ts               GameScorer · GameCandidateProvider ·             │
│                           GameLoadoutApplier · buildDimensions             │
│ worker-pool-factory.ts    creates the real Web Workers                     │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ save-string + SimulateRequest per candidate
               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Base mod sim engine (unchanged upstream design)                            │
│  worker pool: min(cores−1, 12) Web Workers, each running the real game     │
│  combat classes tick-by-tick for N trials                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

The key abstraction is the **Dimension**: one independently-searched coordinate of the
setup. The optimizer treats choices opaquely through callbacks (`getCandidates`,
`applyChoice`, `equals`, `describe`), so equipment slots, prayer sets, spell selections, and
agility obstacles are all "just dimensions" to the search loop.

### Dimensions searched

Built by `buildDimensions` (`adapters.ts`), main pass:

| Dimension | Notes |
| --- | --- |
| Each equipment slot (~13) | includes an explicit **empty** (unequip) candidate — the search may decide a slot is best left bare |
| Summon synergy pair | a **compound** dimension over both summon slots offering declared familiar pairs + empty; *additive* to the two per-slot summon dimensions, which are always searched (they cover solos and non-synergy pairs) |
| Food | owned-only unless pool = all |
| Potion | owned-only unless pool = all |
| Prayers | enumerates none + singles + same-family pairs (easily 150+ candidates) |
| Attack style | legal styles for the current weapon's attack type, re-read each pass |
| Attack spell / Curse / Aurora | legal per current damage type/realm, re-read each pass |

Opt-in **staged progression pass** (§ 5.6), run after the main search on top of the winning
gear: agility obstacles (one dimension per course slot, target's realm) and the cartography
Point of Interest.

Candidate lists are recomputed from **live world state** each time a dimension is visited,
so coupled-slot legality (2H ↔ shield ↔ ammo, weapon ↔ style ↔ spells) tracks the current
partner choices, and equipment conflict resolution is delegated to the game's own equip
logic (the optimizer re-snapshots after each `applyChoice` to capture e.g. a 2H weapon
having cleared the shield).

## 4. Candidate generation and pruning

Per equipment slot, `GameCandidateProvider` runs this funnel **before any simulation**:

```
all equippable items for the slot
  │  item pool: owned (ever-found) / craftable (owned ∪ skill-level craftable) / all
  ▼
usability filter        level & equip requirements; attack-type constraint (weapon
  │                     search pinned to the character's attack type by default, resolved
  │                     to a CONCRETE type once per run); quiver gated to ranged;
  │                     ammo ↔ weapon compatibility
  ▼
target-immunity filter  weapons whose damage type the target is immune to are dropped
  │                     (they can never hurt it; each would burn a full tick budget)
  ▼
style-dead stat strip   when the weapon search is pinned to one attack style, other
  │                     styles' offensive bonuses on stat-pure items are stripped before
  │                     dedupe/dominance (they act through formulas that never run)
  ▼
signature dedupe        combat-identical stat-pure items collapse to one representative
  ▼
dominance prune         Pareto: drop items worse-or-equal on every relevant stat than
  │                     some other candidate. Lower-is-better keys (attackSpeed) are
  │                     negated onto a uniform axis first, so a faster weapon is never
  │                     wrongly discarded. Items with genuine combat special effects
  │                     (modifiers classified combat-relevant, special attacks, combat
  │                     effects) are NEVER pruned — only stat-pure items are compared.
  ▼
(optional) analytic pre-rank top-K       OFF by default — see below
  ▼
candidates handed to the search
```

Every stage except the last is **sound**: it only removes items that provably cannot be the
unique best. The one heuristic stage, the **analytic pre-rank** (`analytic-scorer.ts`,
`prerank.ts`), scores each candidate with a closed-form DPS surrogate against a fixed
nominal target (`{hitpoints: 1, evasion: 1e9}`, which collapses the surrogate to a monotonic
`accuracy × avgDamage ÷ interval` gear-quality proxy) and keeps only the top K per slot. It
is a *filter*, never a scorer — the sim always has the final say on the survivors — and it
defaults to off (`preRankTopK = 0`) because too small a K can drop the true winner. The
default narrowing mechanism is instead the fidelity ladder (§ 5.2), which uses *real* sims.

## 5. The optimization algorithm

### 5.1 High-level flow

```
snapshot user's setup (always restored at the end)
evaluate baseline at search fidelity
FOR pass = 1 .. maxPasses (default 3):
    FOR each dimension:
        restore incumbent (best-so-far full loadout)
        candidates ← dimension.getCandidates() minus the current choice
        ── successive-halving ladder (§5.2) narrows candidates cheaply ──
        confirm survivors at full searchTrials
        pick the winner via the accept rule (§5.3) + survivability tie-break (§5.4)
        IF winner ≠ current choice:
            confirm-replicate (§5.5): fresh re-sim must STILL clear the margin
            commit → new incumbent (re-snapshot to capture conflict resolution)
    IF no dimension improved this pass: converged, stop
finalize: re-score the incumbent at final fidelity (user's Simulate trials/ticks,
          no death-abort) → exact metric ± SE, exact death rate, bestFeasible check
report: per-dimension diff vs baseline, warnings, death-risk attribution (§7.3)
restore user's setup
```

Two fidelity tiers do the heavy lifting: the **search** runs at `searchTrials` (default 200)
and the **finalize** re-scores the single winner at the user's Simulate-page settings
(typically 1,000+ trials). With multi-start (§ 5.7) the whole loop runs once per seed.

### 5.2 Successive-halving ladder (adaptive trials)

With "Fast search" on (the default), a dimension's candidates race up a ladder of rising
fidelity instead of each getting a full-trial evaluation:

```
rung 1:  ALL candidates at screenTrials            (= max(10, searchTrials/4))
             keep top max(screenKeep, ⌈k/3⌉)       (screenKeep = 3)
rung 2:  survivors at 3× the trials
             keep top max(screenKeep, ⌈k/3⌉)
…until survivors ≤ screenKeep, or the next rung would reach searchTrials…
confirm: survivors at full searchTrials  ← only these can be accepted
```

Ranking within a rung uses the same feasibility-first comparison as the accept test (with a
zero margin — rungs only *rank*, they never commit). Each rung derives its own sound
death-abort threshold. The ladder is skipped when a dimension has ≤ `screenKeep` candidates,
and degenerates to the old single screen→confirm when `3·screenTrials ≥ searchTrials`. On
large dimensions (the 150+-candidate prayer dimension) this cuts sims per slot several-fold.
`ladderEvalCount` mirrors the exact accounting for the progress estimator (a test keeps the
two in sync).

Screening-rung results are deliberately excluded from the UI leaderboard: a low-trial
outlier is both noisier and max-selection biased, so only full-fidelity evaluations rank.

### 5.3 The accept rule

`better(a, b)` — is candidate `a` strictly better than incumbent `b`?

1. **Feasibility dominates.** Feasible (deathRate ≤ threshold, default 0) beats infeasible,
   always. Among infeasible setups, lower death rate wins (useful when *nothing* survives:
   the search still climbs toward survivability).
2. **Among feasible setups**, the directed metric (sign-flipped for minimize objectives)
   must clear a noise margin:

   ```
   a.value > b.value + max( minImprovement,                    absolute floor (default 0)
                            minRelImprovement · |b.value|,     relative floor
                            significanceZ · √(seA² + seB²) )   statistical band
   ```

   The margin is the **max** of the three terms, not the sum. `significanceZ` defaults to
   1.645 (a one-sided 95% band on the difference of two independent estimates); the
   relative floor is 1% for slayer-task/dungeon targets on the serial path (where no
   `stdError` is available) and 0 otherwise.

### 5.4 Survivability tie-break: worst hit taken

Among candidates that (a) beat the incumbent and (b) are within the noise margin of the
dimension's metric-best, the metric ordering is sampling luck. Rather than let evaluation
order decide, the optimizer prefers the candidate with the **lowest worst-single-hit-taken**
(the game's "Highest Hit Taken", folded through evaluations as `highestDamageTaken`).
Spike damage is what breaks the auto-eat threshold, so this picks the *safer* of two
statistically equivalent setups — e.g. it keeps abyssal-resistance legs over a
metric-equivalent alternative. A genuine metric win is never overridden: anyone the
metric-best truly beats fails condition (b) and can't enter the tie pool.

### 5.5 Confirm-replicate (winner's-curse guard)

The winning candidate is the max of N noisy samples, so its estimate is biased high — and
the memoizing cache would freeze that lucky roll as the incumbent's score for the rest of
the search. Before committing a swap, the optimizer re-simulates the proposed winner **once,
fresh** (bypassing and overwriting the cache) and commits only if the replicate *still*
clears the accept margin — committing with the replicate's unbiased score, never the lucky
sample. Rejection keeps the incumbent (no runner-up promotion). Cost: exactly one extra
evaluation per accepted swap. On by default (`confirmSwaps`).

### 5.6 Staged progression pass (opt-in)

After the gear/consumable search, an optional second pass tunes **character-progression
levers** — the agility course (obstacles for the target's realm) and the cartography Point
of Interest — *on top of the winning gear*, reusing the same optimizer engine, scorer,
cache, and pool with a different `Dimension[]`. The result is merged: original baseline →
best gear + best progression, with both diffs concatenated. It no-ops when there is nothing
to tune. Off by default (`optimizeProgression`) because these are "respec your character"
recommendations rather than "change your gear" ones.

### 5.7 Multi-start restarts

Coordinate ascent is a local search: a bad starting loadout can trap it in a poor basin
(proven by a coupled-slot trap in the test suite). The **Restarts** control (1/3/5, default
1) re-runs the whole search from N seeds and keeps the best result by the same
feasibility-first comparison:

- Seed 0 is always the user's current setup — a multi-start can never do worse than the
  single-start search.
- Each other seed applies a uniformly random candidate to every unlocked dimension
  (mulberry32 RNG seeded from the run start time, so a run is reproducible). The
  attack-type constraint is resolved to a concrete type *once per run*, so a randomized
  seed that ends up unarmed cannot flip the whole search to the wrong weapon class.
- The `MemoizingScorer` is shared across seeds (a large cache win where basins overlap).
- `restarts = 1` deliberately bypasses the multi-start machinery entirely — that path stays
  byte-identical to the plain single search.

### 5.8 What was considered and rejected for the search engine

- **Genetic algorithm** — rejected: multi-start + the compound synergy dimension cover the
  motivating cases with far less machinery and far fewer evaluations.
- **Simulated annealing** (`annealing.ts`) — fully built and tested (multi-dimension
  Metropolis moves, feasibility-hard acceptance) for *emergent* synergies coordinate ascent
  can't cross, but **not wired** into the UI: superseded in priority by multi-start and the
  declared-synergy compound dimension. It remains in the tree as an experimental option.
- **Analytic surrogate as the broad-phase scorer** — the original two-tier plan; rejected
  in favor of "the sim is the judge". The surrogate survives only as the optional pre-rank
  *filter* (§ 4).

## 6. Scoring and statistical rigor

### 6.1 GameScorer — the sim as objective function

An evaluation serializes the mutated sim world to a save string and dispatches a
`SimulateRequest` to a worker, which runs the real combat engine for `trials` fights capped
at `ticks` each. The plotted metric is read exactly as the Simulate chart reads it
(`Simulation.getValue` with the plotter store's key/scale, realm-resolved), so **the
optimizer's numbers are the chart's numbers**. `deathRate` and `highestDamageTaken` ride
along. GP/drop/pet/mark metrics are unsupported as objectives (they require post-sim
store-state coupling; see the roadmap).

**Batch means.** Each evaluation is split into 5 sub-runs *inside one worker call* (the
heavy save decode is paid once), and the metric is reported as the mean of per-batch values
with the batch-means **standard error**. That `stdError` powers the significance gate
(§ 5.3) and the ± readouts in the UI.

**Death-abort.** During the search, a sim aborts as soon as it has accrued more deaths than
the tolerance could possibly forgive (`floor(deathRateThreshold · trials) + 1`; with the
default zero tolerance, the first death aborts). This is pure speed-up on the many
candidates that die, and provably never discards a setup that could still have ended
feasible. The finalize never aborts, so the reported death rate is exact.

**Targets.** Three shapes, all scored through the same machinery:

- *Single monster* — optionally in a dungeon context (`entityId`).
- *Dungeon / stronghold / abyss-depth aggregate* — each distinct area monster is simmed in
  the area's context and folded through the same `averageMonsterData` math as the chart's
  dungeon bar. Approximation (identical to the chart's): every fight sims fresh, so
  HP/food/prayer state does **not** carry over between fights of a run.
- *Slayer task* — each accessible task monster is simmed individually and averaged, with
  the "On Slayer Task" flag **baked into the save string** so the score matches the chart's
  on-task values.

Aggregate evaluations on the pooled path batch each monster's trials into sub-runs and fold
batch *j* across all monsters into one independent aggregate sample — so aggregates get a
real batch-means `stdError` and the significance gate applies to them too. (This closed a
live bug where metric-plateau slots swapped on pure noise — e.g. wizard bottoms committed
onto a melee build.) The pool-less serial path can't batch; the 1% relative floor is its
backstop.

### 6.2 Memoization

`MemoizingScorer` wraps the scorer with a per-run cache keyed by the applied `Settings`
snapshot (Map-aware stable serialization — plain `JSON.stringify` would collapse every
loadout into one colliding key) plus target, trials, ticks, and abort threshold. Convergence
passes re-visit many setups; the cache serves them without re-simming. Deliberate caveat:
sims are stochastic, so the cache memoizes **one sample per key** — a stable estimate that
prevents noise-driven flip-flopping; `evaluateFresh` (used by confirm-replicate and
death-risk attribution) bypasses and overwrites it.

### 6.3 Parallelism

The base mod has a single sequential worker, so the feature stands up its **own worker
pool**, auto-sized to `min(cores − 1, 12)` and reused across runs. The optimizer detects the
scorer's batch capability and fans a dimension's candidates across the pool (setups are
produced serially on the main thread — cheap — then simmed concurrently). Per-request
failures map to an infeasible evaluation for that candidate only, never failing the whole
batch; cancel/terminate fan out to every worker. Aggregate targets also fan their
per-monster sims across the pool. The main thread yields to the event loop every 8
candidates during setup production and cache-served loops, so the page stays paintable and
Cancel stays clickable even on cache-hit-heavy runs.

### 6.4 Why all four noise guards exist

| Guard | Kills this failure mode |
| --- | --- |
| Significance band (`z·SE`) | accepting a swap whose gain is within sampling noise |
| Relative floor (1% on aggregates) | the same, where no SE estimate exists |
| Confirm-replicate | max-of-N selection bias — the *winner's* estimate is inflated even when each estimate is unbiased |
| Worst-hit tie-break | among statistical ties, the pick being decided by luck/evaluation order instead of safety |

They compose: the band and floor gate *candidate vs incumbent*, the replicate re-tests the
*chosen* winner, and the tie-break orders *equivalent* winners.

## 7. UI

The Auto-Optimize page reuses the Simulate page's target and objective selection (the
selected chart bar / inspected entity, and the plot-type/skill metric selectors), adding a
maximize/minimize direction implied by the metric.

### 7.1 Before the run

- **Search scope** — a paper-doll grid of the equipment slots (same layout as the gear
  panels) plus a strip for the non-equipment dimensions. Clicking a cell cycles
  **searched → locked → custom**: locked keeps the current choice; custom opens an
  equipment-dialog-style picker over the slot's *actual* (pool/attack-type/target filtered)
  candidates for hand-picked multi-select. Locked/custom wrap the dimension itself, so
  seeds, progress estimates, and the search all respect the scope automatically.
- **Knobs** — search trials (default 200), Fast search (the ladder, default on), Restarts
  (1/3/5), item pool (owned / craftable / all), attack-type constraint (current / any /
  specific), optional progression pass, optional analytic pre-rank K. Worker count is
  auto-sized, deliberately not a knob.

### 7.2 During the run

Live "currently evaluating" loadout grid, a new-best feed, and a top-setups leaderboard
(full-fidelity evaluations only, ≈-marked when within noise of #1). The progress line shows
what is actually known — pass, dimension, sims done, sims/s, and a `~`-labelled ETA driven
by the exact ladder accounting (`ladderEvalCount`), rescaled at pass boundaries and scaled
by remaining restart seeds; whole-run totals persist across restarts and the progression
pass. The header target is pinned to the run's captured target (the live chart selection
can change mid-run). Cancel returns the best found so far and restores the user's gear.

### 7.3 Results — honesty features

The results panel is designed to *not oversell* the recommendation:

- Title: "Best setup found **(local search — not guaranteed optimal)**".
- `baseline 1,234 ± 56/h → best 1,481 ± 61/h` — metrics with their standard errors.
- **Worst hit taken** baseline → best, so tie-break picks are explainable.
- **Spike-risk warning** (deterministic, not sampled): if the winner's worst hit ≥ its
  auto-eat threshold (read with the winner applied), the sampled death rate is a *lower
  bound* no matter how many trials passed — the panel says so.
- **Full-fidelity feasibility warning**: if the winner survived the search trials but died
  at the finalize (`bestFeasible === false`), an unmissable warning appears above Apply.
  Apply stays enabled — the user decides.
- **Death-risk attribution**: when the winner shows *any* deaths at full fidelity, the page
  automatically re-sims it with each gear change individually reverted (full trials, fresh,
  no abort) and lists which slot carries the risk and what reverting it would cost in
  metric. (Skipped above 12 changes — too expensive.)
- The survival-constraint caption states the statistical truth: a setup passing N deathless
  search trials can still have a true death rate up to ~3/N.
- Per-dimension change list (from → to), total sim count, and the winning loadout rendered
  with changed slots highlighted; the staged pass's agility/cartography changes appear on
  the gear panels' progression strip.

**Apply** installs the recommended `Settings` into the sim configuration (it does not touch
the live game character).

## 8. Integration contract with the base mod

The seams the feature is built on (verified against source; two key globals:
`Global.game` = the editable simulated game we mutate, `Global.melvor` = the real live game
we read the character from; items in the two are distinct instances — match by `.id`):

- **Evaluate one loadout**: mutate `Global.game` → `generateSaveStringSimple()` →
  `Simulator.simulate({saveString, monsterId, entityId, trials, maxTicks, …})` → a
  `SimulationResult`. This bypasses the UI queue and is the single seam the scorer wraps.
  The message protocol multiplexes by request id, which is what makes the N-worker pool
  straightforward.
- **Loadout representation**: runtime state lives on `SimGame`/`SimPlayer`; the
  serializable form (candidate + cache key + Apply payload) is the `Settings` interface,
  round-tripped by `SettingsController.export()/import()`.
- **Item pools**: candidates come from `Global.game.items.equipment` filtered by valid
  slot; ownership is checked against `Global.melvor.stats.itemFindCount(item) > 0`. Note
  the sim engine itself stubs the bank to "has everything" — ownership is enforced by our
  candidate filter, not the engine.
- **Objective readout**: `Global.simulation.getValue(...)` with the plotter store's
  key/scale (realm-suffixed for realmed plot types); death rate directly from the result.
- **Death-abort plumbing**: `deathAbortThreshold` rides the `SimulateRequest` into the
  worker's trial loop (default `Infinity`, so the normal Simulate page is untouched).
- **On-task flag**: baked into the save string per-request for slayer-task targets
  (toggled around a synchronous serialize, then restored).

## 9. Known limitations and approximations

- **Local search.** Coordinate ascent finds a local optimum; multi-start mitigates but does
  not guarantee globality. The UI says so.
- **Dungeon aggregates average per-monster sims** — no HP/food/prayer carry-over between
  fights of a run (identical to the Simulate chart's own dungeon value).
- **Screening is probabilistic.** A ladder rung can, with low probability, eliminate the
  true best candidate on a bad roll. Full-trial confirmation bounds the damage; turning
  Fast search off removes the risk at ~4× the cost.
- **The cache serves one stochastic sample per key** (by design; see § 6.2).
- **Unsupported objectives**: GP/hr, drops, pet/mark chance (post-sim store coupling).
- **Emergent (undeclared) multi-slot synergies** can in principle sit on ridges single-move
  search won't cross; annealing was built for this but isn't wired (see roadmap).
- **Upstream is unmaintained** (last known-good on game v1.3.1); the fork pins that game
  version. A future game update may break the base mod under us.

## 10. Testing

- **Headless engine tests** (vitest, 200+): the purity boundary makes the entire search
  engine testable with fakes — feasibility dominance, ladder eval-count accounting,
  confirm-replicate accept/reject, tie-break, cache hit/overwrite semantics, multi-start
  trap escape, pool scheduling/error isolation, pruning direction (the attackSpeed
  regression), synergy enumeration.
- **Adapter contract tests** (25): the pure logic inside `adapters.ts` exercised against a
  stubbed `Global` — candidate filtering, pool membership, ammo coupling, prune exemptions,
  synergy dimension behavior, target-id resolution.
- **Headless harness** (`npm run harness`): runs the optimizer against an in-process sim
  for end-to-end checks without a browser.
- **In-game verification** is required for anything touching the real game (`Global`-built
  dimensions, worker speedups, Apply): tracked as a checklist in the roadmap.

## 11. Development setup

- Repo: `jeady/combat-simulator` (fork of `mythridium/combat-simulator`); feature branch
  `auto-optimize`. Node 24.x / npm 11.x.
- Build: `npm install`, then `npm run build` → `build/myth-combat-simulator-*.zip` (the
  loadable mod). Tests: `npm test`.
- Dev-load loop (Firefox, full game + mod.io login): subscribe to the official **Creator
  Toolkit** mod once; add a local mod in **Modfile mode** pointing at our built zip; reload
  the game after each rebuild (re-select the new zip, hard-refresh if stale). Browser
  supports Modfile mode only — folder hot-reload is Steam-only; no localhost server needed.
