/**
 * Downloads the Melvor game scripts + data packages needed to boot the combat engine
 * headlessly in Node. Run once; everything is cached under .cache/ (gitignored).
 *
 * The script list + order is parsed from the public game page, then filtered with the same
 * include/exclude rules the mod's InitPayload uses (src/app/worker/payload/init.ts), so the
 * harness loads exactly the scripts the real web worker does.
 *
 *   node tools/headless-sim/download.mjs            # demo data only (default)
 *   node tools/headless-sim/download.mjs --full     # also full + ItA + expansions
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ORIGIN = 'https://melvoridle.com';
const DATA_VERSION = 528; // matches the live DATA_VERSION captured from the session
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');
const SCRIPTS_DIR = join(CACHE, 'scripts');
const DATA_DIR = join(CACHE, 'data');

const INCLUDE = ['melvor', 'cdnjs', 'polyfill'];
const EXCLUDE = [
    'oneui', 'dagre', 'ion.rangeslider', 'animations', 'jquery', 'pixi', 'basis', 'viewport',
    'cloud.js', 'cloudmanager', 'cartographymenu', 'sidebar', 'minibar', 'ifvisible', 'sortable',
    'sweetalert2', 'tippy-bundle', 'fuse', 'blob:', 'email-decode'
];
const matches = (arr, src) => arr.some(l => src.includes(l));

async function exists(p) {
    try { await access(p); return true; } catch { return false; }
}

function safeName(url) {
    // Strip the query string (e.g. ?12097, ?features=...) so paths stay short on Windows.
    return url.replace(/^https?:\/\//, '').replace(/\?.*$/, '').replace(/[^a-z0-9.\-_]/gi, '_');
}

async function getScriptList() {
    const html = await (await fetch(`${ORIGIN}/index_game.php`)).text();
    const raw = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]);
    const abs = raw.map(s => new URL(s, ORIGIN + '/').href);
    return abs.filter(url => {
        const s = url.toLowerCase();
        return s.includes('.js') && matches(INCLUDE, s) && !matches(EXCLUDE, s);
    });
}

async function download(url, dest) {
    if (await exists(dest)) return false;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return true;
}

async function main() {
    const full = process.argv.includes('--full');
    await mkdir(SCRIPTS_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });

    const scripts = await getScriptList();
    console.log(`Script list: ${scripts.length} scripts`);

    const manifest = [];
    let dl = 0;
    for (const url of scripts) {
        const file = safeName(url);
        const dest = join(SCRIPTS_DIR, file);
        if (await download(url, dest)) dl++;
        manifest.push({ url, file });
    }
    console.log(`Scripts: ${dl} downloaded, ${scripts.length - dl} cached`);

    const dataFiles = ['melvorDemo'];
    if (full) dataFiles.push('melvorFull', 'melvorTotH', 'melvorExpansion2', 'melvorItA');
    const dataManifest = [];
    for (const name of dataFiles) {
        const url = `${ORIGIN}/assets/data/${name}.json?${DATA_VERSION}`;
        const dest = join(DATA_DIR, `${name}.json`);
        const did = await download(url, dest);
        console.log(`Data ${name}: ${did ? 'downloaded' : 'cached'}`);
        dataManifest.push({ name, file: `${name}.json` });
    }

    await writeFile(
        join(CACHE, 'manifest.json'),
        JSON.stringify({ origin: ORIGIN, dataVersion: DATA_VERSION, scripts: manifest, data: dataManifest }, null, 2)
    );
    console.log(`\nManifest written. Cache ready at ${CACHE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
