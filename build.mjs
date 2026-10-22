/* ============================================================
   build.mjs — bundle into a single-file HTML (double-click to run, no server needed)
   Usage: node build.mjs
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashInputs } from './tools/build-info.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

const esbuild = join(root, 'node_modules', '.bin', 'esbuild');
const bundlePath = join(dist, 'silent-meridian.js');

// ---- Version consistency check: ui.css?v= in index.html must match the bootstrap's V ----
const srcHtml = readFileSync(join(root, 'index.html'), 'utf8');
const cssV = (srcHtml.match(/ui\.css\?v=([\w.]+)/) || [])[1];
const jsV = (srcHtml.match(/var V = '([\w.]+)'/) || [])[1];
if (!cssV || !jsV || cssV !== jsV) {
  console.error(`✗ Version mismatch: ui.css?v=${cssV} / bootstrap V=${jsV}. Unify them before bundling.`);
  process.exit(1);
}
console.log(`· Version v${jsV} · bundling classic script (file://-loadable)…`);
/* three has two copies: dev goes through index.html's importmap → vendor/three.module.js,
   while esbuild resolves the bare specifier 'three' from node_modules by default.
   The two are byte-identical today, but package.json says ^0.180.0 — a single npm update would
   silently fork the single-file build from dev mode. The alias below forces both sides to use
   the vendor copy, making it the only runtime. */
const vendorThree = join(root, 'vendor', 'three.module.js');
const vendorCore = join(root, 'vendor', 'three.core.js');
if (!existsSync(vendorThree) || !existsSync(vendorCore)) {
  console.error('✗ Missing vendor/three.module.js or vendor/three.core.js (the three runtime needs both).');
  process.exit(1);
}
execFileSync(esbuild, [
  join(root, 'src', 'main.js'),
  '--bundle',
  '--format=iife',
  '--target=es2020',
  '--minify',
  `--alias:three=${vendorThree}`,
  `--outfile=${bundlePath}`,
], { stdio: 'inherit' });

// ---- Stamp the artifact with "version + content hash" ----
// Background: dist/ is committed, and index.html's ?v= only updates when V changes.
// If you edit src/ and forget to rebuild, the file:// path keeps running the old bundle with no warning
// (this happened: P0-4 was fixed but missing from dist, and double-click players still hit it).
// The stamp is written into the bundle itself and used by tools/check-dist.mjs's staleness check.
const rawBundle = readFileSync(bundlePath, 'utf8');
const buildHash = createHash('sha256').update(rawBundle).digest('hex').slice(0, 12);
const buildAt = new Date().toISOString();
const stamp = `/* SM-BUILD v${jsV} ${buildHash} ${buildAt} */\n` +
  `window.__SM_BUILD={v:"${jsV}",hash:"${buildHash}",at:"${buildAt}"};\n`;
writeFileSync(bundlePath, stamp + rawBundle, 'utf8');
console.log(`· Build stamp: v${jsV} · ${buildHash}`);

// ---- Record this build's input fingerprint so tools/check-dist.mjs can detect staleness ----
const inputs = hashInputs(root);
writeFileSync(join(dist, 'build-stamp.json'), JSON.stringify({
  v: jsV, hash: buildHash, at: buildAt, inputs,
}, null, 2) + '\n', 'utf8');

console.log('· Inlining HTML…');
let html = srcHtml;
const css = readFileSync(join(root, 'styles', 'ui.css'), 'utf8');
const js = readFileSync(bundlePath, 'utf8');

if (/<\/script/i.test(js)) throw new Error('The bundle contains </script and needs escaping');

// Note: replacement functions are mandatory, or `$&` / `$'` in the script would be parsed by String.replace as patterns
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>\n${css}\n</style>`);
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, () => '');
// Single-file mode: tell the bootstrap that "the game code is inlined" and append the bundle before </body>
html = html.replace('<!-- SM:BOOTSTRAP -->', () => '<script>window.__SM_INLINE=1;</script>\n<!-- SM:BOOTSTRAP -->');
html = html.replace('</body>', () => `<script>\n${js}\n</script>\n</body>`);
html = html.replace('<title>', () => `<!-- Single-file build v${jsV} · all resources inlined; double-click to open (works under file://) -->\n<title>`);

const outHtml = join(dist, 'silent-meridian.html');
writeFileSync(outHtml, html, 'utf8');
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✔ dist/silent-meridian.html (${kb} KB, single file, double-click to run)`);
console.log(`✔ dist/silent-meridian.js   (classic script; index.html loads it automatically under file://)`);
