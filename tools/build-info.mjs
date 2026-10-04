/* ============================================================
   build-info.mjs — 构建输入清单与内容哈希（build.mjs 与 check-dist.mjs 共用）
   ------------------------------------------------------------
   为什么需要它：
     背景：dist/ 随版本库提交，且 index.html 的 ?v= 只在 V 变化时才更新。
     改完 src/ 却忘记 node build.mjs 时，file:// 路径会继续跑旧包，
     而旧包和新鲜包在版本号上完全一样，从外部看不出任何差别。
     （实际发生过：P0-4 已修复，但 dist 里没有那个修复，
       于是双击运行的玩家仍然会遇到「暂停→中止→重新部署后整局冻结」。）

   这里用「输入文件内容哈希」而不是 mtime 来判定：
     mtime 在 git clone / 检出后不可靠（所有文件都是检出时间），
     内容哈希则精确等于「src 改过没有」。
   ============================================================ */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 参与打包的全部输入，路径一律相对仓库根，便于跨机器比对 */
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
