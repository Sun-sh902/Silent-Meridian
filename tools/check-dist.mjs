/* ============================================================
   check-dist.mjs — dist/ 陈旧检测（不需要浏览器，秒级）
   ------------------------------------------------------------
   为什么需要：
     dist/ 随仓库提交，而 index.html 在 file:// 下加载的正是
     dist/silent-meridian.js。改完 src/ 忘记重新构建时，双击运行的人
     会继续跑旧包，且旧包与新鲜包版本号相同 —— 完全看不出来。
     实际发生过：P0-4（deploy 未复位 paused）已修，但 dist 里没有，
     于是「暂停 → 中止 → 重新部署 = 整局冻结」在 file:// 路径上依旧存在。

   判定方式：比对 dist/build-stamp.json 里记录的输入内容哈希与当前
   src 下全部 .js、index.html、styles/ui.css 的哈希。用内容而非 mtime，
   因此不受 git clone / 检出顺序影响。

   用法： node tools/check-dist.mjs
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
const REMEDY = '请执行： node build.mjs';

/* ---- 1. 产物是否存在 ---- */
const hasBundle = existsSync(bundle);
const hasHtml = existsSync(html);
check('dist/silent-meridian.js 存在', hasBundle, hasBundle ? '' : REMEDY);
check('dist/silent-meridian.html 存在（单文件版）', hasHtml, hasHtml ? '' : REMEDY);

/* ---- 2. 是否有构建标记 ---- */
const stamp = readStamp();
if (!stamp) {
  check('dist 带有构建标记 build-stamp.json', false,
    '缺失或不可读 —— 属于旧版构建产物，' + REMEDY);
} else if (stamp._corrupt) {
  check('dist 带有构建标记 build-stamp.json', false,
    '无法解析：' + stamp._corrupt + '，' + REMEDY);
} else {
  check('dist 带有构建标记 build-stamp.json', true, 'v' + stamp.v + ' · ' + stamp.hash);

  /* ---- 3. 输入是否变化过（核心：陈旧判定） ---- */
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
    ? [changed.length ? '已改动: ' + changed.join(', ') : '',
       added.length ? '新增: ' + added.join(', ') : '',
       removed.length ? '已删除: ' + removed.join(', ') : ''].filter(Boolean).join(' / ')
    : '输入与构建时一致（' + Object.keys(now).length + ' 个文件）';
  check('dist 不是陈旧的（src / index.html / ui.css 未在构建后被改动）',
    !stale, stale ? detail + ' —— ' + REMEDY : detail);

  /* ---- 4. 包内嵌的标记与 stamp 必须一致（防止手工替换产物） ---- */
  if (hasBundle) {
    const head = readFileSync(bundle, 'utf8').slice(0, 400);
    const m = head.match(/window\.__SM_BUILD=\{v:"([^"]+)",hash:"([^"]+)"/);
    check('包内构建标记与 build-stamp.json 一致',
      !!m && m[1] === stamp.v && m[2] === stamp.hash,
      m ? ('包内 v' + m[1] + ' · ' + m[2] + ' / stamp v' + stamp.v + ' · ' + stamp.hash)
        : ('包头部未找到 __SM_BUILD 标记 —— ' + REMEDY));
  }
}

console.log('');
console.log('===== check-dist =====');
for (const r of results) console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  —  ' + r.detail : ''));
console.log('');
console.log('断言 ' + (results.length - failed) + '/' + results.length + ' 通过');
console.log(failed ? '[RESULT] FAIL' : '[RESULT] PASS');
process.exit(failed ? 1 : 0);
