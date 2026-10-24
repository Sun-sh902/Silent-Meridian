/* ============================================================
   run-all.mjs — run every acceptance suite with one command
   ------------------------------------------------------------
   · checks for Chrome first (one clear message instead of every suite crashing separately)
   · runs everything, then summarises (one failing suite doesn't stop the rest)
   · any suite exiting non-zero => this process exits non-zero
   Usage: npm test
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromePath } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const node = process.execPath;

/* Chrome preflight: exit 2 at once when missing, rather than every suite reporting it */
const chrome = resolveChromePath();
console.log('[run-all] Chrome: ' + chrome);
if (!existsSync(join(ROOT, 'dist', 'silent-meridian.html'))) {
  console.log('[run-all] note: dist/ is missing — check-dist will fail outright,');
  console.log('           and click-test\'s single-file and file:// scenarios will fail too.');
  console.log('           fix: node build.mjs');
}

const SUITES = [
  ['check-dist',        ['tools/check-dist.mjs']],
  ['click-test',        ['tools/click-test.mjs']],
  ['fixes-test',        ['tools/fixes-test.mjs']],
  ['p0-test',           ['tools/p0-test.mjs']],
  ['p1-test',           ['tools/p1-test.mjs']],
  ['map-test',          ['tools/map-test.mjs']],
  ['tuning-test',       ['tools/tuning-test.mjs']],
  ['responsive-test',   ['tools/responsive-test.mjs']],
  ['audio-stress',      ['tools/audio-stress.mjs']],
  ['feel-baseline',     ['tools/feel-baseline.mjs', 'compare', 'tools/feel-baseline.json']],
  ['selftest-red',      ['tools/selftest-red.mjs']],
];

const summary = [];
const t0 = Date.now();
for (const [name, args] of SUITES) {
  const started = Date.now();
  process.stdout.write('[run-all] ' + name + ' … ');
  const r = spawnSync(node, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = r.status === 0;
  console.log((ok ? 'PASS' : 'FAIL') + '  (' + secs + 's)');
  summary.push({ name, ok, status: r.status, secs, out: (r.stdout || '') + (r.stderr || '') });
}

console.log('');
console.log('================ SUMMARY ================');
for (const s of summary) console.log((s.ok ? '  PASS  ' : '  FAIL  ') + s.name.padEnd(18) + s.secs + 's');
const failed = summary.filter((s) => !s.ok);
if (failed.length) {
  console.log('');
  console.log('---------------- FAILURE DETAILS ----------------');
  for (const s of failed) {
    console.log('### ' + s.name + ' (exit ' + s.status + ')');
    const lines = s.out.trimEnd().split('\n');
    const tail = lines.slice(-30);
    tail.forEach((l) => console.log('   ' + l));
    console.log('');
  }
}
console.log('Total ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, ' +
  (summary.length - failed.length) + '/' + summary.length + ' suites passed');
process.exit(failed.length ? 1 : 0);
