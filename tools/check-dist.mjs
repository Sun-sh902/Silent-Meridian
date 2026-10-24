/* ============================================================
   check-dist.mjs — dist/ staleness check (no browser needed, takes seconds)
   ------------------------------------------------------------
   Why:
     dist/ is committed with the repo, and under file:// index.html loads exactly
     dist/silent-meridian.js. If src/ changes and the rebuild is forgotten, double-click players
     keep running the old bundle, which carries the same version as a fresh one — invisible.
     It happened: P0-4 (deploy didn't reset paused) was fixed but not in dist,
     so "pause → abort → redeploy = frozen mission" still existed on the file:// path.

   Method: compare the input content hashes recorded in dist/build-stamp.json with the current
   hashes of every .js under src, index.html and styles/ui.css. Content, not mtime,
   so it is unaffected by git clone / checkout order.

   Usage: node tools/check-dist.mjs
   ============================================================ */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, hashInputs, readStamp } from './build-info.mjs';

const results = [];
let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

const bundle = join(ROOT, 'dist', 'silent-meridian.js');
const html = join(ROOT, 'dist', 'silent-meridian.html');
const REMEDY = 'run: node build.mjs';

/* ---- 1. do the outputs exist ---- */
const hasBundle = existsSync(bundle);
const hasHtml = existsSync(html);
check('dist/silent-meridian.js exists', hasBundle, hasBundle ? '' : REMEDY);
check('dist/silent-meridian.html exists (single-file build)', hasHtml, hasHtml ? '' : REMEDY);

/* ---- 2. is there a build stamp ---- */
const stamp = readStamp();
if (!stamp) {
  check('dist carries build stamp build-stamp.json', false,
    'missing or unreadable — an old-style build output; ' + REMEDY);
} else if (stamp._corrupt) {
  check('dist carries build stamp build-stamp.json', false,
    'cannot parse: ' + stamp._corrupt + '; ' + REMEDY);
} else {
  check('dist carries build stamp build-stamp.json', true, 'v' + stamp.v + ' · ' + stamp.hash);

  /* ---- 3. have the inputs changed (the core staleness check) ---- */
  const now = hashInputs(ROOT);
  const then = stamp.inputs || {};
  const changed = [];
  const added = [];
  for (const rel of Object.keys(now)) {
    if (!(rel in then)) added.push(rel);
    else if (then[rel] !== now[rel]) changed.push(rel);
  }
  const removed = Object.keys(then).filter((rel) => !(rel in now));

  const stale = changed.length + added.length + removed.length > 0;
  const detail = stale
    ? [changed.length ? 'changed: ' + changed.join(', ') : '',
       added.length ? 'added: ' + added.join(', ') : '',
       removed.length ? 'removed: ' + removed.join(', ') : ''].filter(Boolean).join(' / ')
    : 'inputs match the build (' + Object.keys(now).length + ' files)';
  check('dist is not stale (src / index.html / ui.css unchanged since the build)',
    !stale, stale ? detail + ' —— ' + REMEDY : detail);

  /* ---- 4. the stamp embedded in the bundle must match build-stamp.json (guards against hand-swapped outputs) ---- */
  if (hasBundle) {
    const head = readFileSync(bundle, 'utf8').slice(0, 400);
    const m = head.match(/window\.__SM_BUILD=\{v:"([^"]+)",hash:"([^"]+)"/);
    check('in-bundle build stamp matches build-stamp.json',
      !!m && m[1] === stamp.v && m[2] === stamp.hash,
      m ? ('bundle v' + m[1] + ' · ' + m[2] + ' / stamp v' + stamp.v + ' · ' + stamp.hash)
        : ('no __SM_BUILD stamp found at the head of the bundle — ' + REMEDY));
  }
}

console.log('');
console.log('===== check-dist =====');
for (const r of results) console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  —  ' + r.detail : ''));
console.log('');
console.log('Assertions ' + (results.length - failed) + '/' + results.length + ' passed');
console.log(failed ? '[RESULT] FAIL' : '[RESULT] PASS');
process.exit(failed ? 1 : 0);
