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
const weapon =
    game.items.equipment.getObjectByID('melvorD:Black_2H_Sword') ||
    game.items.equipment.getObjectByID('melvorD:Bronze_2H_Sword') ||
    game.items.equipment.getObjectByID('melvorD:Bronze_Sword');
if (weapon) {
    player.equipItem(weapon, 0, weapon.validSlots[0], 1, true);
    console.log('  equipped:', weapon.id);
}

console.log('Running a real simulation vs Cow...');
const saveString = game.generateSaveStringSimple();
const result = await globalThis.__harness.simulate(saveString, 'melvorD:Cow', undefined, 100, 1000);
console.log('  simSuccess:', result.simSuccess, '| reason:', result.reason ?? '-');
console.log('  killTimeS:', result.killTimeS, '| killsPerSecond:', result.killsPerSecond);
console.log('  xpPerSecondMelvor:', result.xpPerSecondMelvor, '| deathRate:', result.deathRate);
console.log('\nHEADLESS SIMULATION RAN');
