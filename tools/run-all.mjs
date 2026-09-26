/* ============================================================
   run-all.mjs — 一条命令跑完全部验收脚本
   ------------------------------------------------------------
   · 先做 Chrome 存在性检查（缺失时立刻给出提示，而不是每个套件各崩一次）
   · 全部跑完再汇总（某个套件失败不会中断其余套件）
   · 任一套件非零退出 => 本进程非零退出
   用法： npm test
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromePath } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const node = process.execPath;

/* Chrome 预检：缺失直接退出 2，避免 7 次重复报错 */
const chrome = resolveChromePath();
console.log('[run-all] Chrome: ' + chrome);
if (!existsSync(join(ROOT, 'dist', 'silent-meridian.html'))) {
  console.log('[run-all] 提示：dist/ 不存在，click-test 的「单文件版」与 file:// 场景会失败。');
  console.log('           先执行 node build.mjs 可生成。');
}

const SUITES = [
  ['click-test',        ['tools/click-test.mjs']],
  ['fixes-test',        ['tools/fixes-test.mjs']],
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
console.log('================ 汇总 ================');
for (const s of summary) console.log((s.ok ? '  PASS  ' : '  FAIL  ') + s.name.padEnd(18) + s.secs + 's');
const failed = summary.filter((s) => !s.ok);
if (failed.length) {
  console.log('');
  console.log('---------------- 失败详情 ----------------');
  for (const s of failed) {
    console.log('### ' + s.name + ' (exit ' + s.status + ')');
    const lines = s.out.trimEnd().split('\n');
    const tail = lines.slice(-30);
    tail.forEach((l) => console.log('   ' + l));
    console.log('');
  }
}
console.log('总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，' +
  (summary.length - failed.length) + '/' + summary.length + ' 套件通过');
process.exit(failed.length ? 1 : 0);
