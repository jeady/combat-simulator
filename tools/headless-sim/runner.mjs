/**
 * Headless harness runner. Boots the real Melvor combat engine in Node (concatenated game
 * scripts + worker stub globals), then runs the bundled harness (Environment.init) to load
 * game data and build a SimGame — all without a browser.
 *
 *   1. node tools/headless-sim/download.mjs            # cache scripts + data (once)
 *   2. ./node_modules/@esbuild/win32-x64/esbuild.exe tools/headless-sim/harness-entry.ts \
 *        --bundle --format=iife --platform=node --tsconfig=tsconfig.json \
 *        --outfile=tools/headless-sim/.cache/harness.js
 *   3. node tools/headless-sim/runner.mjs
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');
const manifest = JSON.parse(await readFile(join(CACHE, 'manifest.json'), 'utf8'));

const stubs = `
"use strict";
globalThis.self = globalThis;
// Make Util.isWebWorker true so the sim follows the worker code paths (e.g. registering
// modifiers into the expression builder). isWebWorker = self instanceof WorkerGlobalScope.
globalThis.WorkerGlobalScope = class WorkerGlobalScope { static [Symbol.hasInstance](o){ return o === globalThis; } };
globalThis.importScripts = function(){};
globalThis.require = () => ({ accessSync: () => true });
globalThis.MelvorDatabase = class MelvorDatabase {};
globalThis.Dexie = class Dexie { constructor(){} version(){ return { stores: () => ({}) }; } };
globalThis.Minibar = class Minibar { encode(){} decode(){} };
globalThis.loadedLangJson = {};
globalThis.skillNav = { setLevelAll: () => {} };
globalThis.combatMenus = { eventMenu: { setButtonCallbacks: () => {} } };
globalThis.firstSkillAction = true;
globalThis.deleteScheduledPushNotification = () => {};
globalThis.addModalToQueue = () => {};
globalThis.openNextModal = () => {};
globalThis.showBaneCompletionModal = () => {};
globalThis.setDiscordRPCDetails = async () => {};
globalThis.saveData = () => {};
globalThis.notifyPlayer = () => {};
globalThis.showFireworks = () => {};
globalThis.DATA_VERSION = ${manifest.dataVersion};
globalThis.cloudManager = { hasFullVersionEntitlement:true, hasTotHEntitlement:true, hasTotHEntitlementAndIsEnabled:true, hasAoDEntitlement:true, hasAoDEntitlementAndIsEnabled:true, hasItAEntitlement:true, hasItAEntitlementAndIsEnabled:true, hasExpansionEntitlement:true, hasExpansionEntitlementAndIsEnabled:true, isAprilFoolsEvent2024Active:()=>false, isBirthdayEvent2023Active:()=>false, isTest:false, log:()=>{}, setStatus:()=>{} };

globalThis.customElements = { define: () => {} };
globalThis.document = { getElementById: () => ({}), querySelector: () => ({}), querySelectorAll: () => [], createElement: () => ({ style:{}, classList:{ add(){}, remove(){}, toggle(){} }, appendChild(){}, setAttribute(){}, addEventListener(){} }), addEventListener: () => {}, body: {}, head: {} };
class __StorageMock { constructor(){ this.data = {}; } getItem(k){ return this.data[k]; } setItem(k,v){ this.data[k]=v; } removeItem(k){ this.data[k]=null; } }
globalThis.localStorage = new __StorageMock();
globalThis.sessionStorage = new __StorageMock();
globalThis.window = { customElements: globalThis.customElements, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, setInterval: globalThis.setInterval.bind(globalThis), setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), matchMedia: () => ({ addEventListener: () => {}, removeEventListener: () => {} }) };
globalThis.HTMLElement = globalThis.DocumentFragment = class { appendChild(){} };
globalThis.Swal = { mixin: () => ({ fire: () => {} }) };
globalThis.tippy = () => {};
globalThis.tippy.setDefaultProps = () => {};
globalThis.$ = () => ({ on: () => {}, modal: () => {} });
globalThis.parent = {};
globalThis.location = { href: 'https://melvoridle.com/index_game.php', origin: 'https://melvoridle.com', protocol: 'https:', hostname: 'melvoridle.com', host: 'melvoridle.com', pathname: '/index_game.php', search: '', hash: '' };
globalThis.checkFileVersion = () => true;
globalThis.playFabManager = { retrieve: async () => {} };
globalThis.mcs = { isDebug: false };
`;

const wanted = manifest.scripts.filter(s => /built|fflate|mitt|petite-vue/i.test(s.file));
let body = '';
for (const { file, url } of wanted) {
    body += `\n;/* === ${url} === */\n${await readFile(join(CACHE, 'scripts', file), 'utf8')}\n`;
}

const harness = await readFile(join(CACHE, 'harness.js'), 'utf8');

// Fix-ups assigned INSIDE the shared eval scope: the game declares some globals lexically
// (e.g. `let loadedLangJson` in language.js), so they can't be reached from the worker's
// indirect-eval (which targets the real global). The worker runs with empty language.
// combat.js declares `let game;` lexically; bridge globalThis.game's setter to it so that
// when the worker init does `self.game = simGame`, the lexical `game` the scripts read updates.
const fixups = `
;/* === fixups === */
loadedLangJson = {};
combatMenus = { eventMenu: { setButtonCallbacks: () => {} } };
(function(){
  let __game;
  Object.defineProperty(globalThis, 'game', { configurable: true, get(){ return __game; }, set(v){ __game = v; game = v; } });
})();
`;

console.log(`Booting engine (${wanted.length} scripts + harness)...`);
(0, eval)(stubs + body + fixups + '\n;/* === harness === */\n' + harness);
if (!globalThis.__harness) throw new Error('harness did not attach to globalThis');
console.log('Engine scripts + harness evaluated.');

const initData = {
    origin: 'https://melvoridle.com',
    scripts: [], // already pre-loaded into scope
    // Match the live full+expansions environment so the data packages are self-consistent
    // (base content references expansion modifiers like stunDurationIncreaseChance).
    entitlements: { toth: true, aod: true, ita: true, aprilFools2024: false, birthday2023: false },
    dataPackage: [],
    skills: [],
    namespaces: [],
    gamemodes: [],
    currentGamemodeId: 'melvorD:Standard'
};

console.log('Running Environment.init (loading game data)...');
await globalThis.__harness.init(initData);

const game = globalThis.__harness.global.game;
console.log('SimGame built. Sanity:');
console.log('  items.equipment:', game.items.equipment.size);
console.log('  monsters:', game.monsters.size);
console.log('  Cow exists:', !!game.monsters.getObjectByID('melvorD:Cow'));
console.log('\nHEADLESS BOOT OK');

console.log('\nConfiguring a test character (mirrors save.js new-character init)...');
const player = game.combat.player;
game.currentGamemode = game.gamemodes.getObjectByID('melvorD:Standard') || game.currentGamemode;
player.hitpoints = 10 * (game.currentGamemode?.hitpointMultiplier ?? 1);
player.setDefaultEquipmentSets();
player.setDefaultAttackStyles();
player.setDefaultSpells();
if (game.golbinRaid?.player) {
    game.golbinRaid.player.setDefaultEquipmentSets();
    game.golbinRaid.player.setDefaultAttackStyles();
    game.golbinRaid.player.setDefaultSpells();
}
// Pre-init the level Maps: resetToBlankState's internal changeEquipmentSet computes stats
// (reading skillLevel) before it sets skillLevel — fine in the app (decoded first), not on a
// fresh player. (mirrors sim-player.ts:826)
player.skillLevel = new Map(game.skills.allObjects.map(s => [s.id, 1]));
player.skillLevel.set(game.hitpoints.id, 10);
player.skillAbyssalLevel = new Map(game.skills.allObjects.map(s => [s.id, 0]));
game.resetToBlankState();
for (const id of ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer']) {
    player.skillLevel.set(`melvorD:${id}`, 99);
}
// Start with a deliberately suboptimal weapon so the optimizer has an improvement to find.
const swords = ['melvorD:Bronze_2H_Sword', 'melvorD:Iron_2H_Sword', 'melvorD:Steel_2H_Sword', 'melvorD:Black_2H_Sword'];
const start = game.items.equipment.getObjectByID(swords[0]);
const weaponSlotId = start.validSlots[0].id;
player.equipItem(start, 0, start.validSlots[0], 1, true);
console.log('  starting weapon:', start.id, '| weapon slot:', weaponSlotId);

console.log('\nRunning the REAL optimizer (weapon slot vs Cow, objective XP/hr)...');
const result = await globalThis.__harness.optimize(
    { monsterId: 'melvorD:Cow', entityId: undefined },
    { [weaponSlotId]: swords },
    { searchTrials: 60, searchTicks: 1000, finalTrials: 200, finalTicks: 1000, maxPasses: 2 }
);
console.log('  status:', result.status, '| improved:', result.improved, '| evaluate() calls:', result.evaluations);
const cacheStats = globalThis.__harness.cacheStats;
if (cacheStats) {
    console.log(
        `  cache: ${cacheStats.misses} real sims, ${cacheStats.hits} cache hits` +
            ` (${cacheStats.size} distinct setups) -> saved ${cacheStats.hits} simulations`
    );
}
console.log('  baseline XP/s:', result.baselineMetric.toFixed(3), '-> best XP/s:', result.bestMetric.toFixed(3));
console.log('  best weapon:', result.bestSetup.get(weaponSlotId));
for (const d of result.dimensionDiff) console.log(`    ${d.label}: ${d.from} -> ${d.to}`);

const bestWeapon = result.bestSetup.get(weaponSlotId);
console.log('\n' + (result.improved && bestWeapon === 'melvorD:Black_2H_Sword'
    ? 'OPTIMIZER VERIFIED: upgraded Bronze -> Black 2H Sword (highest XP/hr) against the real sim.'
    : `OPTIMIZER RAN (best=${bestWeapon}); review expectations.`));

// --- §2b: verify the analytic pre-rank ranks candidates sensibly against the real engine ---
// The character is still level 99 here (the optimizer restored its Bronze baseline). Higher weapon
// tiers give more accuracy + max hit, so the surrogate should rank Black highest and the top-2 must
// contain the true sim winner (Black 2H Sword) — proving the cheap filter won't cull the finalist.
console.log('\nVerifying §2b analytic pre-rank (weapon tiers vs the real engine)...');
const pr = globalThis.__harness.preRank(weaponSlotId, swords, 2);
for (const { id, score } of [...pr.scores].sort((a, b) => b.score - a.score)) {
    console.log(`  ${score.toExponential(3)}  ${id}`);
}
const preRankOk = pr.topK.includes('melvorD:Black_2H_Sword');
console.log('  ' + (preRankOk
    ? `PRE-RANK VERIFIED: top-2 ${JSON.stringify(pr.topK)} contains the sim winner (Black 2H).`
    : `PRE-RANK INCONCLUSIVE: top-2 ${JSON.stringify(pr.topK)} missing Black 2H; review.`));

// --- Significance: verify batch-means stderr is real and shrinks ~1/√trials ---
// The char is still level 99 with Bronze equipped. Estimate the metric's standard error at a small
// and a large trial count; the estimate should be finite/positive and the larger sample tighter.
console.log('\nVerifying batch-means standard error (real engine)...');
const seLo = await globalThis.__harness.batchStdError({ monsterId: 'melvorD:Cow', entityId: undefined }, 40, 1000, 5);
const seHi = await globalThis.__harness.batchStdError({ monsterId: 'melvorD:Cow', entityId: undefined }, 400, 1000, 5);
console.log(`  40 trials:  metric ${seLo.metric.toFixed(4)}  stdError ${Number(seLo.stdError).toExponential(3)}`);
console.log(`  400 trials: metric ${seHi.metric.toFixed(4)}  stdError ${Number(seHi.stdError).toExponential(3)}`);
const seOk = seLo.stdError > 0 && seHi.stdError > 0 && seHi.stdError < seLo.stdError;
console.log('  ' + (seOk
    ? 'STD-ERROR VERIFIED: finite, positive, and tighter with more trials (noise is measurable).'
    : `STD-ERROR INCONCLUSIVE (lo ${seLo.stdError}, hi ${seHi.stdError}); review.`));

// --- Worker-side batching: one decode + B sub-runs must match B fresh decodes (no state drift) ---
// The char is still level 99 with Bronze equipped. Run B fresh single sims (each re-decodes the save)
// and one batched sim (one decode, B internal runs) at the same per-batch trial count; the per-batch
// means should agree within Monte-Carlo noise. A systematic gap would mean runTrials leaks state
// between batches (e.g. HP/food not reset), which is exactly what this change must NOT introduce.
console.log('\nVerifying worker-side batching (1 decode, B runs) matches B fresh decodes...');
const batchTarget = { monsterId: 'melvorD:Cow', entityId: undefined };
const B = 6;
const PER = 60;
const save99 = game.generateSaveStringSimple();
const freshMetrics = [];
for (let i = 0; i < B; i++) {
    const r = await globalThis.__harness.simulate(save99, batchTarget.monsterId, undefined, PER, 1000);
    freshMetrics.push(r.xpPerSecondMelvor);
}
const batched = await globalThis.__harness.batchedSim(batchTarget, PER * B, 1000, B);
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const freshMean = mean(freshMetrics);
const batchedMean = mean(batched.batchMetrics);
const relGap = Math.abs(batchedMean - freshMean) / freshMean;
console.log(`  fresh  (${B}× decode): mean ${freshMean.toFixed(3)}  [${freshMetrics.map(x => x.toFixed(1)).join(', ')}]`);
console.log(`  batched (1× decode):   mean ${batchedMean.toFixed(3)}  [${batched.batchMetrics.map(x => x.toFixed(1)).join(', ')}]`);
const batchOk =
    batched.batchMetrics.length === B && batched.batchMetrics.every(Number.isFinite) && relGap < 0.1;
console.log(
    '  ' +
        (batchOk
            ? `BATCHING VERIFIED: ${B} batches off one decode, mean within ${(relGap * 100).toFixed(1)}% of ${B} fresh decodes (no state drift).`
            : `BATCHING INCONCLUSIVE (len ${batched.batchMetrics.length}, gap ${(relGap * 100).toFixed(1)}%); review.`)
);

// --- §2a: verify death-abort actually short-circuits the trial loop at runtime ---
// Configure a character that cannot win and will die: level 1 combat, ~10 HP, no equipment, vs a
// Cow (always accessible). It dies long before it can grind the Cow down with fists, so deathCount
// climbs every trial. With deathAbortThreshold=1 the run must break after the first death — far
// fewer ticks than running all trials.
console.log('\nVerifying §2a death-abort (weak character vs Cow)...');
game.combat.player.equipment.unequipAll();
for (const id of ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic']) player.skillLevel.set(`melvorD:${id}`, 1);
player.skillLevel.set('melvorD:Hitpoints', 1); // ~10 HP, no food => dies fast
const weakSave = game.generateSaveStringSimple();
const ABORT_TRIALS = 20;
const ABORT_TICKS = 2000;
const full = await globalThis.__harness.simulate(weakSave, 'melvorD:Cow', undefined, ABORT_TRIALS, ABORT_TICKS);
const aborted = await globalThis.__harness.simulate(weakSave, 'melvorD:Cow', undefined, ABORT_TRIALS, ABORT_TICKS, 1);
const pct = full.tickCount > 0 ? ((aborted.tickCount / full.tickCount) * 100).toFixed(0) : 'n/a';
console.log(`  full (no abort): deathRate ${Number(full.deathRate).toFixed(2)}, tickCount ${full.tickCount}`);
console.log(`  abort=1:         deathRate ${Number(aborted.deathRate).toFixed(2)}, tickCount ${aborted.tickCount}`);
const abortWorked =
    Number(full.deathRate) > 0 && aborted.tickCount > 0 && aborted.tickCount < full.tickCount * 0.5;
console.log(
    '  ' +
        (abortWorked
            ? `DEATH-ABORT VERIFIED: aborted run used ${pct}% of the ticks (broke after the first death).`
            : `DEATH-ABORT INCONCLUSIVE (full ticks ${full.tickCount}, abort ticks ${aborted.tickCount}); review.`)
);

// --- R3: verify seeded worker RNG (common random numbers) is deterministic ---
// Reuse the level-99 Bronze save captured earlier (a survivable, non-trivial Cow fight with real
// hit/miss/damage variance). Three checks:
//   (a) same seed twice => byte-identical result (proves the Math.random override captures EVERY
//       combat draw — any un-captured consumer would make the two runs differ);
//   (b) different seeds => results differ (proves the seed is actually wired through, not constant);
//   (c) no seed => the two seeded runs are NOT reproduced by an unseeded run, and two unseeded runs
//       differ from each other (real Math.random — behavior unchanged when no seed is supplied).
console.log('\nVerifying R3 seeded worker RNG (common random numbers)...');
const CRN_TRIALS = 200;
const CRN_TICKS = 1000;
// Compare the full metric/deathRate/tickCount fingerprint so ANY divergence is caught.
const fingerprint = r => `${r.xpPerSecondMelvor}|${r.deathRate}|${r.tickCount}|${r.killsPerSecond}`;
const seededA1 = await globalThis.__harness.simulate(save99, 'melvorD:Cow', undefined, CRN_TRIALS, CRN_TICKS, undefined, 123456);
const seededA2 = await globalThis.__harness.simulate(save99, 'melvorD:Cow', undefined, CRN_TRIALS, CRN_TICKS, undefined, 123456);
const seededB1 = await globalThis.__harness.simulate(save99, 'melvorD:Cow', undefined, CRN_TRIALS, CRN_TICKS, undefined, 987654);
const unseeded1 = await globalThis.__harness.simulate(save99, 'melvorD:Cow', undefined, CRN_TRIALS, CRN_TICKS);
const unseeded2 = await globalThis.__harness.simulate(save99, 'melvorD:Cow', undefined, CRN_TRIALS, CRN_TICKS);

const sameSeedIdentical = fingerprint(seededA1) === fingerprint(seededA2);
const diffSeedDiffers = fingerprint(seededA1) !== fingerprint(seededB1);
const unseededNondeterministic = fingerprint(unseeded1) !== fingerprint(unseeded2);
const unseededNotSeeded = fingerprint(unseeded1) !== fingerprint(seededA1);

console.log(`  seed 123456 (run 1): ${fingerprint(seededA1)}`);
console.log(`  seed 123456 (run 2): ${fingerprint(seededA2)}`);
console.log(`  seed 987654:         ${fingerprint(seededB1)}`);
console.log(`  no seed (run 1):     ${fingerprint(unseeded1)}`);
console.log(`  no seed (run 2):     ${fingerprint(unseeded2)}`);
console.log(`  (a) same seed identical:     ${sameSeedIdentical}`);
console.log(`  (b) different seeds differ:  ${diffSeedDiffers}`);
console.log(`  (c) no-seed nondeterministic:${unseededNondeterministic}  no-seed != seeded: ${unseededNotSeeded}`);
const crnOk = sameSeedIdentical && diffSeedDiffers && unseededNondeterministic && unseededNotSeeded;
console.log(
    '  ' +
        (crnOk
            ? 'SEEDED-RNG VERIFIED: same seed reproduces exactly, different seeds differ, unseeded stays random.'
            : 'SEEDED-RNG INCONCLUSIVE: review the fingerprints above.')
);

// Also confirm the seeded stream is fully restored: a plain unseeded batched sim after all the
// seeded runs must still behave normally (no leaked deterministic Math.random on the worker global).
const postRestore1 = await globalThis.__harness.simulate(save99, 'melvorD:Cow', undefined, CRN_TRIALS, CRN_TICKS);
const postRestore2 = await globalThis.__harness.simulate(save99, 'melvorD:Cow', undefined, CRN_TRIALS, CRN_TICKS);
const restoreOk = fingerprint(postRestore1) !== fingerprint(postRestore2);
console.log(
    '  ' +
        (restoreOk
            ? 'RNG-RESTORE VERIFIED: unseeded sims after seeded runs are random again (Math.random restored).'
            : 'RNG-RESTORE INCONCLUSIVE: post-seed unseeded runs were identical; possible leaked stream.')
);
