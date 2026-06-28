/**
 * Feasibility probe: can the Melvor game scripts be evaluated in Node and expose their
 * classes? They use strict-mode top-level `class` declarations that only share scope within
 * a single evaluation, so we concatenate them (with the worker's stub globals) and eval once,
 * then check whether the key classes are defined in that shared scope.
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');
const manifest = JSON.parse(await readFile(join(CACHE, 'manifest.json'), 'utf8'));

// Mirror the worker's load-time global stubs (Environment.init + detach + cloudManager).
const stubs = `
"use strict";
globalThis.self = globalThis;
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

// --- WorkerMock browser stubs (src/worker/context/mock.ts) ---
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
`;

// Load only the built game scripts + a couple of needed libs (skip UI libs / polyfill).
const wanted = manifest.scripts.filter(s => /built|fflate|mitt|petite-vue/i.test(s.file));
console.log(`Concatenating ${wanted.length} of ${manifest.scripts.length} scripts...`);

let body = '';
for (const { file, url } of wanted) {
    const code = await readFile(join(CACHE, 'scripts', file), 'utf8');
    body += `\n;/* === ${url} === */\n${code}\n`;
}

const epilogue = `
;globalThis.__PROBE__ = {
  Game: typeof Game, Player: typeof Player, SaveWriter: typeof SaveWriter,
  CombatManager: typeof CombatManager, Item: typeof Item, Monster: typeof Monster,
  NamespaceRegistry: typeof NamespaceRegistry, EquipmentItem: typeof EquipmentItem
};
`;

try {
    // Indirect eval runs in the global scope and shares one lexical scope across all scripts.
    (0, eval)(stubs + body + epilogue);
    console.log('LOADED OK');
} catch (e) {
    console.error('EVAL ERROR:', e.message);
    console.error((e.stack || '').split('\n').slice(0, 6).join('\n'));
}
console.log('Classes:', JSON.stringify(globalThis.__PROBE__ || null));
