/*
 * KAT: mirror the Scratch library assets we are licensed to use, EXCLUDING the trademarked mascot
 * characters (Cat, Gobo, Pico, Nano, Tera, Giga). Run once from the repo root: `node kat-mirror-assets.mjs`.
 *
 * It does two things:
 *   1. Removes the mascot sprites + costumes from src/lib/libraries/{sprites,costumes}.json so they never
 *      appear in the pickers (no trademarked graphics, no broken entries).
 *   2. Downloads every remaining referenced asset to static/scratch-assets/<md5ext> (resumable: it skips
 *      files already present, so you can re-run it safely).
 */
import fs from 'node:fs';
import path from 'node:path';

const LIB = 'src/lib/libraries';
const OUT = 'static/scratch-assets';
const MASCOT = /\b(cat|gobo|pico|nano|tera|giga)\b/i;
const CONCURRENCY = 12;

const read = f => JSON.parse(fs.readFileSync(path.join(LIB, f), 'utf8'));
const write = (f, d) => fs.writeFileSync(path.join(LIB, f), JSON.stringify(d));

let sprites = read('sprites.json');
let costumes = read('costumes.json');
const backdrops = read('backdrops.json');
const sounds = read('sounds.json');

const dropped = sprites.filter(s => MASCOT.test(s.name)).map(s => s.name);
sprites = sprites.filter(s => !MASCOT.test(s.name));
costumes = costumes.filter(c => !MASCOT.test(c.name));
write('sprites.json', sprites);
write('costumes.json', costumes);
console.log('Removed mascot sprites:', dropped.join(', '));

const md5 = new Set();
for (const s of sprites) {
    for (const c of s.costumes || []) if (c.md5ext) md5.add(c.md5ext);
    for (const so of s.sounds || []) if (so.md5ext) md5.add(so.md5ext);
}
for (const c of costumes) if (c.md5ext) md5.add(c.md5ext);
for (const b of backdrops) if (b.md5ext) md5.add(b.md5ext);
for (const so of sounds) if (so.md5ext) md5.add(so.md5ext);
const all = [...md5];
console.log('Assets to fetch:', all.length);

fs.mkdirSync(OUT, {recursive: true});
let done = 0, skipped = 0;
const failed = [];

async function fetchOne (m) {
    const dest = path.join(OUT, m);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        skipped++;
        return;
    }
    const url = `https://assets.scratch.mit.edu/internalapi/asset/${m}/get/`;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('status ' + r.status);
            fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
            done++;
            if ((done + skipped) % 100 === 0) console.log(`  ${done + skipped}/${all.length}`);
            return;
        } catch (e) {
            if (attempt === 2) failed.push(m);
            else await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
        }
    }
}

let idx = 0;
const worker = async () => {
    while (idx < all.length) await fetchOne(all[idx++]);
};
await Promise.all(Array.from({length: CONCURRENCY}, worker));

console.log(`\nDone. downloaded ${done}, skipped ${skipped}, failed ${failed.length}`);
if (failed.length) console.log('failed (first 20):', failed.slice(0, 20).join(', '));
