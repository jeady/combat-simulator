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
| **Targets** | A single monster (optionally in a dungeon context via `entityId`), a **dungeon/stronghold/abyss-depth** aggregate, OR a **slayer task**. A slayer task isn't one simulatable entity: the scorer sims each accessible task monster individually (through the worker pool when present) and averages them, exactly as the Simulate chart does. The task id may arrive in either `monsterId` (dropdown pick) or `entityId` (inspect), so both are checked (`slayerTaskTargetId`); a task with no reachable monster is unsupported. A dungeon/stronghold/abyss-depth aggregate (`dungeonTargetId` — the area id lands in `monsterId` when its chart bar is selected without inspecting) is scored the same way: each of the area's distinct monsters is simmed in the area's context (`entityId` = area id) and folded through the same `averageMonsterData` math as the chart's dungeon-level bar. **Approximation:** dungeon scoring is a per-monster average — every fight sims fresh, so HP/food/prayer-point state does NOT carry over between fights of a run — identical to the approximation the Simulate chart's dungeon value already makes. An aggregate with no simmable monsters is unsupported (rejected up front by `isSupportedTarget`). |
| **Search scope** | Gear (each slot, incl. attack-style, summon-synergy pairs), prayers/potions/food, attack spell/curse/aurora — searched together in the main pass; **agility obstacles** + **cartography** in an opt-in staged progression pass — each included only as the sim actually models it. |
| **Item pool** | UI **tri-state**: *owned* (ever-found, from the live save), *craftable* (owned OR a high enough skill level to craft — the level check only), or *all items in game* (raw game data). Same engine, one `ItemPool` arg to the candidate provider. Consumables follow the coarse owned-vs-all split (`itemPool !== 'all'`). |
| **Attack type** | The weapon search is constrained to the character's *current* attack type by default (a magic build isn't handed a melee weapon); `any` searches every type. Also gates the Quiver slot, and the applier auto-fits compatible ammo when it equips a ranged weapon so ranged candidates sim fairly. |
| **UI** | New "Auto-Optimize" panel. Separately, **simplify the existing (confusing) objective-selector UI**. |

## 4. The core problem

Brute force is impossible: ~13 gear slots × hundreds of items, plus agility/prayers/
potions/food/style/spells/familiars/cartography → an astronomically large product.
The design makes it tractable with a **two-tier scorer** and a **smart search**.

### Scoring — how it actually shipped

The original two-tier plan cast the analytic surrogate as the BROAD-search scorer. That is **not**
what was built. As implemented:

1. **The full stochastic sim is the scorer for the whole search**, not just a top-K finalist stage.
   Every candidate at every rung is a real worker sim; `GameScorer.evaluate` reads the same plotted
   metric + death rate the Simulate chart uses. Speed comes from fewer *trials* (two-tier
   `searchTrials`→`finalTrials` fidelity) and a successive-halving ladder, not from a cheaper scorer.
2. **The analytic surrogate is a per-slot pre-FILTER, not a scorer.** `analytic-scorer.ts` +
   `makeGameScoreItem` rank a slot's candidates against a fixed nominal target and keep only the
   top-K before any sim runs (`PreRankingCandidateProvider`). It never produces a `{metric,
   deathRate}` an accept decision is made on — the sim always has the final say. It is **off by
   default** (`preRankTopK = 0`); `fastSearch` low-trial screening (real sims) is the preferred
   default narrowing. See `docs/auto-optimize-search.md` §2b.

### Candidate pruning

Per dimension: pick source (owned / craftable / all) → filter by usability (level/slot/style/
attack-type) → collapse combat-identical stat-pure items to one representative (`dedupeBySignature`)
→ drop **dominated** options (Pareto-worse across all relevant stats, with lower-is-better keys like
attackSpeed projected onto a uniform axis first). Items with special effects are never pruned.

### Search engine (as built)

- **Shipped:** coordinate ascent (optimize one dimension at a time, iterate up to `maxPasses`) +
  optional random restarts (`multiStart`, wired behind the "Restarts" control).
- Enforces hard constraints (survive — death rate is feasibility-dominant; mutually-exclusive
  choices; ammo/style/rune consistency), caches evaluated loadouts (`MemoizingScorer`), and runs
  evaluations across a **worker pool we create** (`WorkerPool`, auto-sized) — the base mod has only
  one sequential worker (§9.5), so we instantiate our own. **✗ NOT built:** a time/evaluation budget
  (the run bounds itself by `maxPasses` + candidate counts, not a wall-clock/eval cap).
- **✗ NOT built:** a genetic algorithm. Simulated annealing (`annealing.ts`) IS built and tested but
  **NOT wired** into the UI (experimental; superseded in priority by multi-start + the compound
  summon dimension). See `docs/auto-optimize-search.md` §1b(ii).

### Orchestration

Coordinate ascent (optionally multi-start) narrows to a best loadout, then a full-fidelity re-score
confirms it (`finalTrials`/`finalTicks`) and sets `bestFeasible`. The result reports a **diff vs the
player's current gear** (`dimensionDiff`) with baseline/best metric ± standard error. **✗ NOT built:**
per-slot **marginal-contribution** reporting — the result carries the from→to diff per dimension but
not each dimension's isolated metric contribution.

An **opt-in staged progression pass** runs after the gear/consumable search: it tunes the agility
course (for the target monster's realm) and the cartography Point of Interest ON TOP of the winning
gear, reusing the same optimizer/scorer/pool with a different `Dimension[]`, and returns a merged
result (baseline → best gear + best progression, diffs concatenated). No-ops when there's nothing to
tune. Gated by `optimizeProgression` (default off). See `auto-optimize.ts` `_runProgressionPass`.

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

- **P0 — Spike / de-risk. ✅ COMPLETE — see §9 for the verified contract.** Built the fork,
  established the Firefox dev-load loop, and mapped the code seams (evaluate entry point,
  loadout data shape, owned-items source, metric + death-rate readout). Still to do within
  P0: pin/confirm game v1.3.1 in the live client.
- **P1 — MVP. ✅.** Gear, owned items, full-sim scoring, single target, coordinate-ascent search.
  Proves the loop end-to-end.
- **P2 — Make it fast. ✅ (mostly).** Candidate pruning + dedupe, worker parallelism (auto-sized
  pool), caching, successive-halving screening, death-abort, and the analytic pre-rank FILTER all
  landed. The analytic surrogate is a per-slot pre-filter (off by default), not the broad scorer as
  originally framed — see §4.
- **P3 — Expand dimensions. ✅.** Agility (staged pass), prayers/potions/food, attack
  style/spells/curses/auroras, summoning familiars (incl. declared synergy pairs), cartography
  (staged pass); tri-state owned/craftable/all pool.
- **P4 — Search quality & UX. ◑.** Restarts (multi-start) for cold-start local optima, survive-
  constraint handling, and the results-explanation UI (diff, ± standard error, feasibility/noise
  warnings) all landed. **NOT built:** a genetic algorithm, per-slot marginal-contribution
  reporting, a time/eval budget; simulated annealing is built+tested but not wired. The
  objective-selector simplification is out of this feature's scope.

## 7. Open questions / risks

- ~~**Browser dev-load loop**~~ — ✅ resolved, see §10. Firefox uses Creator Toolkit
  "Modfile mode" (point it at our `build/*.zip`); no localhost server needed.
- ~~**Worker pool**~~ — ✅ resolved: there is no pool; single sequential worker (§9.5).
  We must instantiate our own `Worker`s for parallelism.
- **Analytic surrogate fidelity:** how closely Tier-1 estimates track Tier-2 sim across
  styles/effects; may need per-metric calibration.
- **Cartography modeling:** how the sim represents cartography combat bonuses (free choice
  vs fixed by surveyed map) — confirm before treating it as a search dimension.
- **Metric store-state coupling:** GP/drop/pet/mark metrics aren't pure functions of one
  sim — they require `Drops.update()` and correct `plotter` store state (§9.4). The "skill"
  selector only affects Pet/Mark metrics; XP keys are driven by **realm**, not skill.
- **Game-version drift:** upstream is unmaintained; a future game update may break the base
  mod. We stay pinned to v1.3.1 for now.

## 8. Dev setup (current)

- Repo: `jeady/combat-simulator` (`origin`), `mythridium/combat-simulator` (`upstream`).
- Build: `npm install` then `npm run build` → `build/*.zip` (the loadable mod).
- Toolchain verified: Node 24.x, npm 11.x, git, gh.
- Branch: `auto-optimize` (this doc lives here).
- Play/test client: **Firefox** (keeps the main Chrome idle session undisturbed).

## 9. P0 findings — verified integration contract

All references are `file:line` in this repo, confirmed by reading source. Two key globals:
`Global.game` = `SimGame` (the **editable simulated** game/player we mutate);
`Global.melvor` = the **real live** Melvor `Game` (read current character from here).
Items in the two `Game`s are distinct instances — **match by `.id`**.

**9.1 Core scorer seam (evaluate one loadout vs one target).**
Mutate `Global.game.combat.player` / `SimGame` managers → `Global.game.generateSaveStringSimple()`
(`src/shared/simulator/sim-game.ts:483`) → `await Global.simulation.simulator.simulate({ saveString,
monsterId, entityId, trials, maxTicks })` (`src/app/worker/simulator.ts:37`) → returns a
`SimulationResult`. This bypasses the UI queue (`Simulation.startQueue()`, `src/app/simulation.ts:844`)
and is the single function the search loop should wrap. Message protocol:
`MessageAction.{Init,Simulate,Cancel}` over a `Transport` that multiplexes by message `id`
(`src/shared/transport/`); worker handler at `src/worker/main.ts:21` → `Simulator.simulateMonster`
(`src/worker/simulator.ts:5`).

**9.2 Loadout representation.** Two forms:
- *Runtime:* `SimGame`/`SimPlayer` (`src/shared/simulator/sim-{game,player}.ts`) — gear, styles,
  `spellSelection.{attack,curse,aurora}`, prayers, food, potion, `skillLevel` map, agility/astrology/
  cartography on managers. Config UI pages write directly into `Global.game`.
- *Serializable (use as candidate + cache key):* `interface Settings`
  (`src/app/settings-controller.ts:35`). `SettingsController.export()`/`import()` convert to/from
  the live `SimGame`; `importFromEquipmentSet(i)` (`:92`) builds one from the live player.

**9.3 Item pools.**
- *All items:* `Global.game.items.equipment.filter(i => i.validSlots.some(s => s.id === slotId))`
  (canonical picker pattern, `…/equipment-slot/equipment-slot.ts:146`).
- *Owned only:* same, filtered by `Global.melvor.stats.itemFindCount(item) > 0` (ever-found) or
  `Global.melvor.bank.getQty(item) > 0` (in bank now), with the id round-trip. **Note:** the sim
  stubs the bank to "infinite/has-everything" (`sim-game.ts:53-56`), so ownership is *not* enforced
  by the engine — we filter the candidate list ourselves.

**9.4 Objective function (skill + plot-type → number).**
`score = Global.simulation.getValue(true, result, key, scale)` (`src/app/simulation.ts:317`), where
`key`/`scale` come from `Global.stores.plotter.plotType` (`src/app/stores/plotter.store.ts`, `enum
PlotKey`). For `isRealmed` plot types the key gets a realm suffix (e.g. `xpPerSecond` →
`xpPerSecondMelvor`). **Survival constraint:** read `result.deathRate` directly. **Caveat:** GP/drop/
pet/mark fields return `NaN` from the worker and are filled by `Drops.update()` (`src/app/drops.ts:26`)
using `plotter` store state — so for those metrics set the store + call `Drops.update()` before scoring.

**9.5 Parallelism — single sequential worker (no pool).**
`Simulation` → one `Simulator` → one `WebWorker` → one `new Worker(...)` (`src/app/worker/web-worker.ts:7`);
jobs drained sequentially by `startQueue()`. `Transport` keys responses by id, so dispatch bookkeeping
across N workers is easy — but throughput is bounded by worker **count**, which is 1 today. For batching
candidates we instantiate our own `Worker`s (each needs its own `MessageAction.Init` handshake).

## 10. Dev-load loop (Firefox) — verified

Browser modding uses the **Creator Toolkit** (an official in-game mod). Browser supports **Modfile
mode only** (point it at a built `.zip`); **Directory Link** folder hot-reload is **Steam-only**.
**No localhost server is needed.** Requires the **Full version** + a mod.io login linked to your Melvor
account (not the free demo).

1. *One-time:* Mod Manager → Browse → search **"Creator Toolkit"** → Subscribe → reload game.
2. Build: `npm run build` → `build/myth-combat-simulator-*.zip`.
3. Open **Creator Toolkit** (Mod Manager tab / sidebar / asterisk shortcut) → add a **local mod
   (Modfile)** → select our zip.
4. *(Optional)* link the local mod to its mod.io profile (matching `namespace`) to override the
   installed mod.io copy and enable persistent settings storage.
5. Reload the game → our build loads (local mods load before mod.io mods).
6. *Iterate:* edit → `npm run build` → re-select the new zip in the Toolkit → reload the tab
   (hard-refresh Ctrl+Shift+R if a change doesn't appear).

Source: [Creator Toolkit wiki](https://wiki.melvoridle.com/w/Mod_Creation/Creator_Toolkit),
[Getting Started](https://wiki.melvoridle.com/w/Mod_Creation/Getting_Started).
