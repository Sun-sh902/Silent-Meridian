/* ============================================================
   build-info.mjs — build input list and content hashes (shared by build.mjs and check-dist.mjs)
   ------------------------------------------------------------
   Why this exists:
     Background: dist/ is committed to the repository, and index.html's ?v= only changes when V does.
     If you edit src/ and forget node build.mjs, the file:// path keeps running the old bundle,
     and the old and fresh bundles have identical version numbers — invisible from the outside.
     (This actually happened: P0-4 was fixed, but dist/ did not contain the fix,
       so double-click players still hit "pause → abort → redeploy freezes the whole run".)

   This uses content hashes of input files rather than mtime:
     mtime is unreliable after git clone / checkout (every file has checkout time),
     while a content hash precisely answers "did src change?".
   ============================================================ */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** All inputs that participate in bundling; paths are relative to the repo root for cross-machine comparison */
export function buildInputs(root = ROOT) {
  const files = [];
  const srcDir = join(root, 'src');
  if (existsSync(srcDir)) {
    for (const f of readdirSync(srcDir).sort()) {
      if (f.endsWith('.js')) files.push('src/' + f);
    }
  }
  files.push('index.html', 'styles/ui.css');
  return files;
}

export function hashFile(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
}

export function hashInputs(root = ROOT) {
  const out = {};
  for (const rel of buildInputs(root)) out[rel] = hashFile(root, rel);
  return out;
}

export const STAMP_PATH = 'dist/build-stamp.json';

export function readStamp(root = ROOT) {
  const p = join(root, STAMP_PATH);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { _corrupt: String(e && e.message ? e.message : e) };
  }
}
