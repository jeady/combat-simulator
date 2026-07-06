# Auto-Optimize — Common Random Numbers (seeded worker RNG)

Design note for roadmap item **R3** (`docs/auto-optimize-roadmap.md`). Companion to
`docs/auto-optimize-design.md` (§6 scoring/statistics, §8 integration seams).

Status: investigation complete, **plumbing prototyped and verified headless** (this branch).
The optimizer-side exploitation (paired statistics, shared seeds across a comparison) is
**designed here but deliberately NOT implemented** — see §6.

---

## 1. Why common random numbers

Every evaluation is a Monte-Carlo simulation. The optimizer accepts a swap A over incumbent
B only when A's metric clears a noise margin (design §5.3):

```
a.value > b.value + max( minImprovement, minRelImprovement·|b.value|, z·√(seA² + seB²) )
```

The statistical band `z·√(seA² + seB²)` assumes A and B are estimated **independently**. If
instead A and B are simulated on the *same* random streams — same hit/miss rolls, same damage
rolls, same special-attack selection, trial for trial — then their estimates become positively
correlated and the variance of the *difference* collapses:

```
Var(Â − B̂) = Var(Â) + Var(B̂) − 2·Cov(Â, B̂)
```

For two loadouts that differ only slightly, `Cov` is large and `Var(Â − B̂)` can be a small
fraction of the independent-case `Var(Â) + Var(B̂)`. That means the gate can distinguish far
smaller *true* differences at the same trial count — or the same differences at far fewer
trials. This is the single biggest remaining lever on search quality per sim spent. It was
flagged high-value/high-risk because it reaches into the upstream game combat engine we
otherwise never touch.

This note covers only the **plumbing** to make seeded streams *available*. Actually exploiting
the correlation for a tighter gate needs paired-difference statistics, which is a separate
phase (§6). The plumbing is safe to land first because with the current unpaired gate,
positive correlation only makes the gate *more conservative*, never anti-conservative (§6.2).

---

## 2. Where randomness enters a worker simulation

Verified against the cached game scripts under `tools/headless-sim/.cache/scripts/` (game
v1.3.1, the fork's pinned version) and the worker/transport source.

### 2.1 The game draws all combat randomness through `Math.random()` at the call site

The game's RNG helpers live in `utils.js` and every one of them calls the **global**
`Math.random()` freshly at call time — none caches a reference to the function:

| Helper | Body (paraphrased) |
| --- | --- |
| `rollPercentage(chance)` | `chance > Math.random() * 100` |
| `rollInteger(min, max)` | `Math.floor(Math.random() * (max−min+1)) + min` |
| `generateGaussianNumber(mean, sd)` | two `Math.random()` draws, Box–Muller |
| `sample_from_binomial(n, p)` | one `Math.random()` draw against a binomial CMF |
| `getRandomArrayElement(arr)` | `rollInteger(0, len−1)` |
| `getExclusiveRandomArrayElements` | repeated `rollInteger` |
| `rollForOffItem(base)` | `rollPercentage(...)` |

All the combat-relevant randomness flows through these. In `character.js` (the shared
Player/Enemy base) the combat draws are:

- `rollToHit` → `rollPercentage(target.modifiers.dodgeChance)`, `rollPercentage(this.stats.hitChance)`,
  `rollPercentage(this.modifiers.convertMissIntoHit)`;
- crit → `rollPercentage(getCritChance(...))`;
- damage/reflect → `rollInteger(0, ...)`;
- special-attack selection → the one direct call, `const attackRoll = Math.random() * 100;`
  (`character.js` ~line 1461), which is still a fresh global call.

Because none of these captures `Math.random` into a variable, **overriding
`globalThis.Math.random` before the trial loop redirects every one of them** to our seeded
generator. No game code needs patching.

### 2.2 No crypto / non-`Math.random` randomness in the combat path

`crypto.getRandomValues` / `crypto.subtle` appear only in `jsrsasign` (a bundled crypto
library, cloud-save signing) and `dexie` (IndexedDB) — neither is on the worker combat path,
and neither is even loaded by the headless worker boot (the harness/worker load only the
`built_*` game scripts + fflate/mitt/petite-vue). The other direct `Math.random()` hits in the
cache are all in non-combat skills that never tick in a combat sim (astrology, fishing,
`save.js` GUID, `rockTicking`, township, raidManager rendering, enemy.js image selection).
Nothing in the combat tick loop bypasses `Math.random`.

### 2.3 Worker concurrency: one Simulate per worker at a time

The seam must not have another randomness consumer running concurrently on the same global.
Confirmed it does not:

- `Transport.onmessage` (`src/shared/transport/transport.ts`) is `async` and `await`s the
  registered handler for each message. The `Simulate` handler (`src/worker/main.ts`) `await`s
  `Global.simulator.simulateMonster{,Batched}`, which `await`s `runBatches` → `runTrials`.
- The optimizer's `WorkerPool` (`src/app/optimizer/worker-pool.ts`) claims one idle worker per
  request for the request's whole duration and only returns it to the pool afterward
  (`parallelMap` caps in-flight tasks at the pool size). So a given worker global handles
  exactly one `Simulate` at a time.
- The only other message a busy worker can receive mid-sim is `Cancel`, whose handler just
  sets `Global.cancelStatus = true` — it draws **no** randomness.
- `runTrials` yields to the event loop (`await setTimeout`) every 100 000 ticks so Cancel can
  land. During that microtask gap no second `Simulate` is dispatched to the same worker, and
  Cancel consumes no draws. So the installed `Math.random` is used exclusively by the
  in-flight trial loop for its whole lifetime.

**Conclusion of Stage 1: the seam is clean.** Installing a seeded `Math.random` on the worker
global around one `runBatches` call, and restoring the original in a `finally`, captures *all*
combat randomness for that request with zero upstream game-code changes and no concurrency
hazard.

---

## 3. Plumbing (implemented on this branch)

The design mirrors the existing `deathAbortThreshold` / `batches` plumbing exactly: an
optional field on `SimulateRequest` that is inert when absent, so the base Simulate page stays
**byte-identical**.

### 3.1 Transport type

`src/shared/transport/type/simulate.ts` — add `rngSeed?: number` to `SimulateRequest`.
Omitted/undefined ⇒ the worker leaves `Math.random` untouched (current behavior).

### 3.2 App-side passthrough

`src/app/worker/simulator.ts` `Simulator.simulate` copies `rngSeed` into the message `data`
alongside `deathAbortThreshold` and `batches`. (The base Simulate page's `GameScorer`/plot code
never sets it, so it is always `undefined` there.)

### 3.3 Worker install/restore

`src/worker/main.ts` reads `data.rngSeed` and forwards it to
`Global.simulator.simulateMonster{,Batched}`. `src/worker/simulator.ts` `runBatches` installs
the seeded PRNG around the batch/trial loop:

```
const restore = installSeededRandom(rngSeed);   // no-op + null when rngSeed == null
try {
    ... decode, onLoad, initForWebWorker, runTrials loop ...
} finally {
    restore?.();                                 // always restore the real Math.random
}
```

The PRNG helper is a small pure module `src/worker/rng.ts`:

- `mulberry32(seed)` — the project's existing PRNG choice (identical to the one in
  `auto-optimize.ts` and the optimizer tests), returning floats in `[0, 1)`.
- `installSeededRandom(seed)` — if `seed == null` returns `null` (caller skips restore, so the
  absent-seed path never even touches `Math.random`); otherwise saves `Math.random`, assigns a
  fresh mulberry32 stream to `Math.random`, and returns a `restore` closure that puts the
  original back. Install/restore is synchronous and paired in a `finally`, so a throw still
  restores.

`installSeededRandom` is deliberately tiny and pure (no game imports) so it is unit-testable
headless.

---

## 4. Stream alignment: per-trial re-seeding, not per-request

The naive scheme — seed once per request and let the whole batch/trial loop draw from one
stream — **desynchronizes immediately** and defeats the entire purpose:

- Different candidates consume a *different number of draws per trial*. A faster weapon lands
  more hits per fight; a candidate with a special attack draws an extra selection roll every
  attack; a dodge-heavy target burns extra `rollPercentage` calls. After trial 1, candidate A
  and candidate B are at different positions in their (identical) stream, so trial 2 onward is
  effectively independent noise again — no correlation, no variance reduction.
- **Death-abort makes this worse**: a candidate that dies early aborts its run (design §6.1),
  consuming far fewer draws than a candidate that survives, so even the *number of trials*
  differs across candidates.

The fix is to make **trial _i_ comparable across candidates** by re-seeding deterministically
per trial from a per-request base seed:

```
for each trial i in 0 .. trials-1:
    Math.random = mulberry32( mix(baseSeed, i) )   // fresh stream, aligned by trial index
    run one fight
```

where `mix(seed, i)` is a cheap integer hash that avalanches the pair into a well-distributed
32-bit seed (so consecutive trials don't get correlated streams). A mulberry32-style mix works:

```
mix(seed, i):
    let h = (seed ^ (i * 0x9E3779B1)) >>> 0        // golden-ratio odd constant decorrelates i
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0
    return (h ^ (h >>> 16)) >>> 0
```

Now trial _i_ of candidate A and trial _i_ of candidate B start from the **same** stream. They
diverge *within* a trial as soon as their draw counts differ, but they share the whole common
prefix (both start their fight from the same first hit/miss roll, same first damage roll, …),
which is where most of the correlation — and thus the variance reduction — comes from. Trials
stay aligned even when death-abort cuts candidate A's run short at trial _k_ < trials: trials
`0..k` still line up with B's trials `0..k`.

### 4.1 Where the re-seed lives

`runTrials` runs one continuous `while` loop over kills+deaths, not an explicit per-trial loop
— a "trial" ends when the enemy or player dies and the next spawns. Re-seeding cleanly per
trial therefore wants a hook at fight boundaries. Two options, in increasing invasiveness:

1. **Batch-granular (implemented now, conservative).** Re-seed once per *batch* sub-run
   (`runBatches` already calls `runTrials` once per batch). With B batches, batch _j_ of every
   candidate shares a base stream `mulberry32(mix(baseSeed, j))`. This aligns the *batch-mean*
   estimates across candidates — which is exactly the granularity the significance gate and
   the batch-means SE (design §6.1) operate at — without touching the upstream `runTrials`
   fight loop at all. It captures the batch-level common-prefix correlation (each batch's first
   fight is aligned) and is the safest first step. **This is what the prototype installs.**

2. **Trial-granular (future, more reduction).** Re-seed at every fight boundary inside
   `runTrials` (hook `spawnEnemy`/trial completion). Strictly more alignment, but it edits the
   upstream trial loop and interacts with death-abort bookkeeping, so it is deferred until the
   paired-statistics phase (§6) actually consumes the correlation — there is no point paying the
   upstream-edit risk before the gate can exploit it.

The chosen scheme (batch-granular per-request base seed, per-batch re-seed) is documented in
`src/worker/simulator.ts`. It is a strict improvement over one-stream-per-request and is
non-invasive; the trial-granular refinement is a labeled follow-up.

---

## 5. Interaction with existing machinery

- **Memoizing cache (design §6.2).** The cache key already includes `trials`, `ticks`, target,
  and the applied `Settings` snapshot. Add `rngSeed` to the key. With a fixed seed, *same seed +
  same setup ⇒ genuinely identical result*, so the cache stays coherent — a cache hit now
  returns the exact result a re-sim would, strengthening the "one stable sample per key"
  property rather than weakening it. (Without adding the seed to the key, two runs with
  different seeds would collide; with it, they stay distinct.)
- **Batch-means stdError (design §6.1).** Unchanged in the plumbing phase. Each batch is still
  an independent sample *for a given candidate* (different batches use different mixed seeds),
  so the batch-means SE remains a valid estimate of that candidate's own sampling error. CRN
  correlates the *same batch index across candidates*, which is what a future paired SE reads —
  it does not correlate batches *within* one candidate, so per-candidate SE is untouched.
- **Confirm-replicate (design §5.5).** `evaluateFresh` bypasses the cache to get an unbiased
  re-sample. It should use a *different* seed from the search evaluation (e.g. derive from a run
  counter), so the replicate is a genuinely fresh draw rather than a bit-identical repeat of the
  lucky sample. This is an optimizer-side concern (§6), not part of the plumbing.

---

## 6. How the optimizer should exploit this later (NOT implemented this round)

Scope limit for R3: the plumbing lands; the exploitation does not. Recorded here so the next
phase doesn't re-derive it.

### 6.1 Shared seeds within one dimension comparison

When the optimizer evaluates a dimension's candidates against the incumbent, it should pass the
**same `rngSeed`** to every candidate *and* to the incumbent's (re)evaluation in that
comparison. Then candidate A and incumbent B are simmed on aligned streams and the gate can be
paired. A fresh seed per dimension visit (or per pass) keeps successive comparisons from
reusing one lucky/unlucky stream forever.

### 6.2 The statistics caveat (why plumbing is safe before paired stats)

The current gate uses `z·√(seA² + seB²)` — the SE of the difference of two *independent*
estimates. Under CRN the estimates are positively correlated, so the *true* SE of the
difference is:

```
SE(Â − B̂) = √(seA² + seB² − 2·ρ·seA·seB)   ≤   √(seA² + seB²)   for ρ ≥ 0
```

So with positively correlated estimates the current formula **overstates** the SE of the
difference. The gate margin is therefore too wide: it demands a *larger* observed gap than it
needs to. That means the gate becomes **conservative** — it loses statistical power (misses some
real improvements) but it **never becomes anti-conservative** (never accepts a swap it
shouldn't on inflated confidence). Conservative is the safe failure direction for a
status-quo-biased search. **Therefore the seed plumbing can be enabled before the paired
statistics exist**: correctness is preserved, only some power is left on the table until phase 2.

### 6.3 Paired-difference SE (phase 2)

To actually *recover* the power CRN offers, the scorer must compute a paired SE. With B aligned
batches per candidate, form the per-batch differences `d_j = Aâ±_j − B̂_j` (batch _j_ of A minus
batch _j_ of B, sharing seed `mix(baseSeed, j)`), then:

```
SE_paired = stdev(d_j) / √B
gate:  mean(d_j) > max(minImprovement, minRelImprovement·|B̄|, z·SE_paired)
```

`SE_paired` directly measures `Var(Â − B̂)` including the covariance — no `ρ` to estimate. This
is where the trial-granular re-seed (§4.1 option 2) pays off, because more alignment ⇒ smaller
`stdev(d_j)`. Phase 2 is: (a) shared seeds per comparison, (b) paired SE in the scorer/gate,
optionally (c) trial-granular re-seeding.

---

## 7. Verification plan

Headless via the harness (`npm run harness`; `tools/headless-sim/harness-entry.ts` exposes
`__harness.simulate(save, monsterId, entityId, trials, ticks, deathAbort?, rngSeed?)`):

1. **Determinism** — same `rngSeed` twice ⇒ byte-identical `SimulationResult` (metric,
   deathRate, tickCount). This is the load-bearing check: it proves the override actually
   captures every draw (any un-captured `Math.random` would make the two runs differ).
2. **Seed sensitivity** — different `rngSeed`s ⇒ results differ (proves the seed is actually
   wired through and the stream isn't accidentally constant).
3. **Inertness** — no `rngSeed` ⇒ behavior unchanged (two no-seed runs differ from each other
   as before — real `Math.random` — and neither equals a seeded run).
4. **Unit** — `src/worker/rng.ts`: `mulberry32` is deterministic for a fixed seed and its
   outputs are in `[0, 1)`; `installSeededRandom(seed)` makes `Math.random` deterministic and
   `restore()` puts the exact original function back; `installSeededRandom(undefined)` is a
   no-op returning `null`.

The harness runs the *real* worker `Simulator` against the *real* game engine in-process, so a
green determinism check is strong evidence the seam captures all combat randomness at the pinned
game version.

---

## 8. Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Game-version drift** — a future game update caches `Math.random` into a variable, or adds a combat draw via `crypto`, silently breaking capture. | Medium | The determinism harness check (§7.1) detects it immediately — a re-seed that no longer reproduces means an un-captured consumer appeared. Run the harness as part of the version-bump checklist. The fork is pinned to v1.3.1, so drift only happens on a deliberate bump. |
| **Hidden randomness consumer** — some rare combat path (a specific monster special, a modded item) draws outside the helpers or before install. | Low | All audited combat draws go through `Math.random` at call time (§2.1); the override is global, so anything using `Math.random` is captured regardless of path. Only a *non*-`Math.random` source would escape — none found in the combat scripts. |
| **Worker global pollution** — a throw between install and restore leaks the seeded `Math.random` into later requests on that worker. | Low | Install/restore is paired in a `finally` in `runBatches`, which wraps the entire decode+loop in try/catch already. Restore is synchronous and cannot be skipped. A unit test asserts `restore()` reinstalls the original reference. |
| **Concurrency** — another request draws on the same global mid-sim. | Very low | Ruled out in §2.3: one Simulate per worker at a time; Cancel draws nothing. |
| **Determinism false-confidence** — the plumbing is byte-identical-safe but the *exploitation* (paired gate) is not yet built; someone assumes CRN is already improving the search. | Low (process) | This note (§6) states plainly that only the plumbing lands and that the unpaired gate is merely conservative, not yet tighter, under CRN. |
| **Seeded stream quality** — mulberry32 correlations between the per-trial mixed seeds cause structured (non-i.i.d.) noise. | Low | The `mix()` avalanche (§4) decorrelates adjacent trial indices; mulberry32 is already the project's vetted choice for reproducible search seeds. Batch-means SE would surface gross structure as inflated variance. |

---

## 9. Summary

- **Stage 1 (investigate): clean seam confirmed.** All combat randomness flows through global
  `Math.random()` at the call site; no crypto/cached-reference consumers on the combat path;
  one Simulate per worker at a time. Overriding `Math.random` around `runBatches` captures
  everything with zero upstream game edits.
- **Stage 2 (design): this note.** Per-request base seed with **per-batch re-seeding**
  (`mix(baseSeed, batchIndex)`) chosen over one-stream-per-request (which desyncs after trial 1)
  and over trial-granular re-seeding (deferred as an invasive follow-up until the paired gate
  can use it).
- **Stage 3 (prototype): implemented** — `rngSeed?` on `SimulateRequest`, app-side passthrough,
  worker install/restore via a small pure `src/worker/rng.ts`. Absent seed ⇒ byte-identical to
  today.
- **Stage 4 (verify): headless harness** proves determinism, seed sensitivity, and inertness.
- **Not this round (scope):** shared seeds per comparison, paired-difference SE, and wiring into
  `GameScorer`/optimizer/UI. Safe to defer — the unpaired gate is only *conservative* under CRN,
  never anti-conservative (§6.2).
