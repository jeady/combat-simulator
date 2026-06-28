# Auto-Optimize Mode — Design & Plan

> A fork-local feature adding an **auto-optimize** mode to the Myth Combat Simulator:
> given a target and an objective, efficiently search across gear, agility, prayers,
> potions, food, style/spells/runes, familiars, and cartography to find the best loadout.

This document is the living plan. It is not part of upstream; it lives in our fork
(`jeady/combat-simulator`) to keep the design discoverable next to the code.

---

## 1. Goal

The base mod evaluates **one** combat setup at a time against a monster/dungeon and
reports metrics (kills/hr, XP/hr, GP/hr, death rate, …). Auto-optimize wraps that
"evaluate one setup" machinery in a smart search loop that finds the **best** setup
for a chosen target and objective, instead of making the player try combinations by hand.

## 2. How the base mod works (what we build on)

- TypeScript + Webpack, GPL-3.0. Modern descendant of *Combat Simulator Reloaded*.
- Runs the **real game combat classes** (`Player`/`Enemy`/`CombatManager`) inside
  **Web Workers**, simulating fights tick-by-tick to produce averaged metrics.
- A "setup" = gear per slot, levels, attack style, spell/curse/aurora, prayers, potion,
  food, agility course, summons, etc. — imported from the live character.
- Source layout: `src/worker/` (sim engine), `src/app/` (UI), `src/shared/`,
  `src/main.ts`, `src/setup.ts`, `src/manifest.json`.
- **Maintenance risk:** upstream unmaintained since Feb 2025; last known-good on game
  **v1.3.1**. Pin the game version for development.

## 3. Key decisions (locked)

| Area | Decision |
| --- | --- |
| **Objective** | Reuse the mod's existing *skill* + *plot type* metric selectors as the scoring function. Add a per-metric **maximize/minimize** direction flag. |
| **Survival** | **Death rate is a hard constraint, not just a metric** — optimize the chosen metric only among loadouts that reliably survive. |
| **Search scope** | Gear, agility obstacles, prayers/potions/food, attack style + spells/runes, **summoning familiars**, **cartography** — each included only as the sim actually models it. |
| **Item pool** | UI **toggle**: *owned/usable-only* (from the live save) vs *all items in game* (from raw game data). Same engine, different candidate provider. |
| **UI** | New "Auto-Optimize" panel. Separately, **simplify the existing (confusing) objective-selector UI**. |

## 4. The core problem

Brute force is impossible: ~13 gear slots × hundreds of items, plus agility/prayers/
potions/food/style/spells/familiars/cartography → an astronomically large product.
The design makes it tractable with a **two-tier scorer** and a **smart search**.

### Two-tier scoring

Common interface: `evaluate(loadout) -> { metric, deathRate }`.

1. **Tier 1 — analytic surrogate (no Monte Carlo).** Estimate the selected metric from
   `CombatManager`-derived deterministic stats (max hit, accuracy, attack interval,
   damage reduction, …). Thousands of evals/sec — used for the broad search.
2. **Tier 2 — full stochastic sim.** The existing worker simulation. Accurate but slow —
   used only on the top-K finalists to get true metric + death rate.

### Candidate pruning

Per dimension: pick source (owned/all) → filter by usability (level/slot/style) →
drop **dominated** options (strictly worse in all relevant stats than another).

### Search engine

- **MVP:** coordinate ascent (optimize one slot at a time, iterate) + random restarts.
- **Later:** genetic algorithm / simulated annealing to handle **set bonuses and
  special-weapon synergies**, which trap naive greedy search.
- Enforces hard constraints (survive; mutually-exclusive choices; ammo/style/rune
  consistency), caches evaluated loadouts, respects a time/evaluation budget, and uses
  the mod's existing **worker pool** for parallelism.

### Orchestration

Analytic search narrows the space → full-sim the top-K → report the best loadout **with
each slot's marginal contribution** and a **diff vs the player's current gear**, so the
result is explainable.

## 5. Architecture (modules)

```
Loadout model        the setup object the sim already understands; the optimizer mutates it
Candidate provider   owned/all source -> usability filter -> dominance prune
Scorer               evaluate(loadout) -> {metric, deathRate}   (Tier 1 analytic | Tier 2 sim)
Search engine        coordinate ascent + restarts (MVP); GA/annealing later; constraints; cache; budget
Orchestrator         analytic narrow -> full-sim top-K -> best + per-slot contribution + diff
UI                   Auto-Optimize panel (target, objective, item-pool toggle, constraints, budget, run, results)
```

## 6. Phased roadmap

- **P0 — Spike / de-risk.** Build the fork (done), pin game v1.3.1, establish the Chrome
  dev-load loop, and map the code seams:
  - the `evaluate(setup)` entry point (how a setup is dispatched to the workers),
  - the setup/loadout data shape (equipped item, agility course, summon, …),
  - where **owned items** come from (live bank/equipment),
  - how the selected **metric + death rate** come back out.
- **P1 — MVP.** Gear-only, owned items, full-sim scoring, single target, coordinate-ascent
  search. Proves the loop end-to-end.
- **P2 — Make it fast.** Analytic surrogate + candidate pruning + worker parallelism + caching.
- **P3 — Expand dimensions.** Agility, prayers/potions/food, style/spells/runes, familiars,
  cartography; owned/all toggle.
- **P4 — Search quality & UX.** GA/restarts for set bonuses, survive-constraint handling,
  results-explanation UI, and the objective-selector simplification.

## 7. Open questions / risks

- **Browser dev-load loop:** exact steps to side-load a local build into the Chrome
  Melvor client via the Mod Manager (verify in P0; drives iteration speed).
- **Analytic surrogate fidelity:** how closely Tier-1 estimates track Tier-2 sim across
  styles/effects; may need per-metric calibration.
- **Cartography modeling:** how the sim represents cartography combat bonuses (free choice
  vs fixed by surveyed map) — confirm before treating it as a search dimension.
- **Game-version drift:** upstream is unmaintained; a future game update may break the base
  mod. We stay pinned to v1.3.1 for now.

## 8. Dev setup (current)

- Repo: `jeady/combat-simulator` (`origin`), `mythridium/combat-simulator` (`upstream`).
- Build: `npm install` then `npm run build` → `build/*.zip` (the loadable mod).
- Toolchain verified: Node 24.x, npm 11.x, git, gh.
