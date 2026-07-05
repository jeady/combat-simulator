# Auto-Optimize — Roadmap

Companion to `docs/auto-optimize-design.md` (which describes what is built and how it
works). This doc lists only **work not yet done**: recommended items with rationale and
rough priority, an in-game verification backlog, and ideas that were considered and
consciously dropped (kept here so they aren't re-litigated from scratch).

Status date: 2026-07-05, branch `auto-optimize`.

---

## Recommended work

### R1. Wall-clock / evaluation budget — HIGH value, LOW effort

The run currently bounds itself only by `maxPasses` × candidate counts; on a large pool
("all items", restarts 3+) that can be a long, unpredictable commitment, and the only
escape is Cancel. Add a `budget` to `OptimizeOptions` (seconds and/or max evaluations),
checked in the optimizer loop exactly where the cancel token is checked; on expiry, stop
cleanly and return the best-so-far with `status: 'aborted'` (the result path already
handles cancelled-with-partial-result, so the UI work is one status label). Expose as an
optional "Time limit" field on the panel.

### R2. Generalize death-risk attribution into full change attribution — HIGH value, LOW effort

`_analyzeRisk` already implements leave-one-out attribution (re-sim the winner with each
change individually reverted, full trials, fresh) — but only runs when the winner shows
deaths. The same mechanism answers the much more common question *"which of these 6 changes
actually mattered?"*: the metric delta per reverted change **is** the per-slot marginal
contribution the original design wanted. Make it an opt-in "Explain changes" button on the
results panel (post-run, so it costs nothing unless asked; keep the ≤12-changes cap). This
closes the last "NOT built" item from the original orchestration design at a fraction of
its originally-estimated cost.

### R3. Common random numbers / seeded worker RNG — HIGH value, HIGH risk (investigate first)

The single biggest remaining lever on search quality per sim spent. If candidate A and
incumbent B are simmed on the *same* random streams, the variance of (A − B) collapses and
the significance gate can distinguish far smaller real differences at the same trial count
(or the same differences at far fewer trials). Requires a seedable RNG in the worker's
combat engine and per-request seed plumbing — invasive in upstream sim code we otherwise
don't touch, hence: investigation spike first (can the game's RNG be seeded per trial
without behavioral drift?), then a design note before any implementation. Flagged
high-value/high-risk since the original remediation plan; still true.

### R4. GP/hr, drops, and pet/mark objectives — MEDIUM value, MEDIUM effort

Currently rejected up front (`UNSUPPORTED_KEYS`). These metrics aren't pure functions of
one sim result — the worker returns NaN and the app fills them via `Drops.update()` from
plotter-store state. Supporting at least GP/hr (a commonly wanted objective) means calling
the drops pipeline per evaluation with the right store state, and auditing that it's safe
to do concurrently from pooled results. Scope carefully: GP/hr first; pet/mark chance only
if it falls out naturally.

### R5. Coupled-slot revalidation audit — MEDIUM value (correctness), LOW-MEDIUM effort

Dimensions re-read live world state each visit, and equipment conflicts resolve through the
game's own equip logic — but there is no *explicit* re-validation that a previously
committed choice is still legal after a partner changed (the original plan flagged summon
`isSynergyUnlocked` re-validation "critical"; style/spell gating after a weapon swap is the
other case). Likely mostly fine in practice because candidates regenerate each pass; the
work is a focused audit + regression tests proving each coupling (weapon→style,
weapon→spell/curse/aurora, summon-pair validity) self-corrects within a pass, fixing
anything that doesn't.

### R6. Presets (Fast / Balanced / Thorough) — LOW value, LOW effort

The knob set has grown (trials, fast search, restarts, pool, attack type, progression,
pre-rank). Three presets that set them as a group, with the existing controls as the
"advanced" tier, would help new users; defaults are already sensible so this is polish.

### R7. In-game verification backlog

Human-only checks still outstanding from the remediation and post-checklist fixes:

- Slayer-task target with the pool: confirm the per-monster parallel speedup (B3) and sane
  results; re-run the Ruin slayer-coin search — metric-neutral slots should stay on the
  incumbent gear (aggregate stdError fix).
- `restarts: 3` run: seeds shown in status, cancel mid-seed restores gear, seeds keep the
  resolved attack type.
- Dungeon/stronghold/abyss-depth aggregate target end-to-end.
- Attack-style dimension (B4): optimize a melee build; confirm stab/slash/block are
  searched and the best style applied.
- Ammo edge: ranged build with quantity-1 ammo equipped — confirm ranged sims don't run dry.
- Page responsiveness re-check on a big dimension (Cancel clickable mid-dimension).
- 1-worker vs auto-worker run: identical (noise-tied) recommendations, wall-clock speedup.

### R8. Housekeeping

- Confirm the live client is still on game v1.3.1 (the fork's pinned version) and record
  the check; watch for upstream/game drift — a game update can break the base mod under us.
- Headless dying-scenario harness check asserting death-abort actually shortens a run
  (tick count ≪ trials × tickLimit) — the one §2a follow-up test never written.

---

## Considered and dropped (do not revive without new evidence)

- **Genetic algorithm.** Multi-start restarts + the compound (declared-synergy) dimension
  cover the motivating failure modes with far fewer evaluations and far less machinery.
- **Candidate ordering within a dimension** (sim strongest-first to strengthen the
  incumbent sooner). The successive-halving ladder already concentrates sims on plausible
  winners; measured benefit would be marginal.
- **Analytic pre-rank as a default.** It's a heuristic filter that can drop the true
  winner; `fastSearch` (real low-trial sims) is the safer default narrowing. Pre-rank stays
  available behind `preRankTopK` for huge pools.
- **Per-slot marginal-contribution reporting as originally scoped** (isolated contribution
  measured during the search) — superseded by R2, which gets the same answer post-hoc from
  the leave-one-out mechanism that already exists.

## Conditional (wire only if a real case demands it)

- **Simulated annealing** (`annealing.ts` — built, tested, unwired). Exists for *emergent*
  multi-slot synergies that single-move search plus declared-pair moves can't reach. Wire
  it behind an advanced toggle only if a concrete loadout is found that multi-start
  demonstrably misses; until then it stays an experimental module so the UI surface stays
  simple.
