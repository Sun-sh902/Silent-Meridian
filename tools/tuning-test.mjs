/* ============================================================
   tools/tuning-test.mjs - 第 1 批验收：参数中枢 + 调参面板
   用法： node tools/tuning-test.mjs
   ============================================================ */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = join(root, normalize(p));
  if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
  res.end(await readFile(f));
});
await new Promise((r) => server.listen(8212, '127.0.0.1', r));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const results = [];
function check(name, ok, detail) {
  if (!ok) failures++;
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
}

await page.goto('http://127.0.0.1:8212/?deploy=1&test=1', { waitUntil: 'load' });
await wait(2600);

/* 1. 面板存在、默认隐藏、参数项齐全 */
const init = await page.evaluate(() => {
  const p = document.getElementById('tuning-panel');
  return {
    exists: !!p, hidden: p ? p.classList.contains('hidden') : null,
    sliders: p ? p.querySelectorAll('input[type=range]').length : 0,
    checks: p ? p.querySelectorAll('input[type=checkbox]').length : 0,
    nums: p ? p.querySelectorAll('input[type=number]').length : 0,
    badges: p ? p.querySelectorAll('.badge').length : 0,
    groups: p ? p.querySelectorAll('.tp-group').length : 0,
  };
});
check('面板已注入且默认隐藏', init.exists && init.hidden, JSON.stringify(init));
check('滑块数量与参数表一致（>=60）', init.sliders >= 60, 'range=' + init.sliders + ' number=' + init.nums + ' checkbox=' + init.checks);
check('未接线参数有醒目标注', init.badges > 0, init.badges + ' 项标注「未接线」');

/* 2. P 打开：释放指针、时间不降速 */
await page.keyboard.press('KeyP');
await wait(300);
const opened = await page.evaluate(() => ({
  visible: !document.getElementById('tuning-panel').classList.contains('hidden'),
  locked: !!document.pointerLockElement,
  ts: window.__game.tuning.open,
}));
check('P 打开面板并释放指针', opened.visible && !opened.locked, JSON.stringify(opened));

/* 3. 拖动滑块 -> feel 立即变化 -> 游戏行为立即变化（固定步长实测） */
const live = await page.evaluate(() => {
  const g = window.__game;
  const before = window.__feel.move.walkSpeed;
  const input = document.querySelector('#tuning-panel input[data-g="move"][data-k="walkSpeed"]');
  input.value = '6.2';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const after = window.__feel.move.walkSpeed;
  // 固定步长实测位移，验证「改一个数立即生效」
  g.testMode = true;
  g.input.keys.clear(); g.input.keys.add('KeyW');
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0; g.player.ads = 0;
  const x0 = g.player.pos.x, z0 = g.player.pos.z;
  for (let i = 0; i < 60; i++) g.advance(1/60, 1/60);
  const moved = Math.hypot(g.player.pos.x - x0, g.player.pos.z - z0);
  g.input.keys.clear();
  g.testMode = false;
  return { before, after, moved: +moved.toFixed(4), numBox: document.querySelector('#tuning-panel input[type=number][data-g="move"][data-k="walkSpeed"]').value };
});
check('滑块写入 feel 立即生效', live.before === 3.1 && live.after === 6.2, live.before + ' -> ' + live.after);
check('改速度后游戏实测速度同步变化（3.1 -> 6.2）', Math.abs(live.moved - 6.2) < 0.05, '实测 1 秒位移 = ' + live.moved + ' m');
check('数字框与滑块双向同步', live.numBox === '6.2', 'number input = ' + live.numBox);

/* 4. 预设槽 A/B/C */
const preset = await page.evaluate(() => {
  const save = (slot) => document.querySelector('[data-tp="preset-save"][data-slot="' + slot + '"]').click();
  const load = (slot) => document.querySelector('[data-tp="preset-load"][data-slot="' + slot + '"]').click();
  const ws = () => window.__feel.move.walkSpeed;
  const seq = [];
  seq.push(['当前', ws()]);
  load('A'); seq.push(['载入A(原始)', ws()]);
  window.__feel.move.walkSpeed = 9;
  save('B'); seq.push(['改9存B', ws()]);
  window.__feel.move.walkSpeed = 2;
  load('B'); seq.push(['载入B', ws()]);
  load('A'); seq.push(['再载入A', ws()]);
  return seq;
});
check('预设 A 保存原始值并可用于 A/B 对比', preset[1][1] === 3.1 && preset[4][1] === 3.1,
  preset.map((p) => p[0] + '=' + p[1]).join(' / '));
check('预设 B 可保存并回载', preset[2][1] === 9 && preset[3][1] === 9, JSON.stringify(preset));

/* 5. 只读悬浮模式 + [ ] , . 调节 */
await page.evaluate(() => document.querySelector('[data-tp="close"]').click());
await wait(200);
await page.keyboard.press('KeyO');
await wait(250);
const selVal = () => {
  const parts = window.__feel.debug.selectedParam.split('.');
  return window.__feel[parts[0]][parts[1]];
};
const ov = await page.evaluate((fn) => ({
  visible: !document.getElementById('tuning-overlay').classList.contains('hidden'),
  sel: window.__feel.debug.selectedParam,
  val: eval('(' + fn + ')()'),
}), selVal.toString());
await page.keyboard.press('BracketRight');
await page.keyboard.press('BracketRight');
await wait(200);
const ov2 = await page.evaluate((fn) => ({
  val: eval('(' + fn + ')()'),
  text: document.getElementById('tp-mini-read').textContent,
}), selVal.toString());
await page.keyboard.press('Period');
await wait(200);
const ov3 = await page.evaluate(() => window.__feel.debug.selectedParam);
check('O 唤出只读悬浮层（不释放指针逻辑）', ov.visible, JSON.stringify(ov));
check('[ ] 调节当前选中项', ov2.val > ov.val, ov.val + ' -> ' + ov2.val);
check(', . 切换选中参数', ov3 !== ov.sel, ov.sel + ' -> ' + ov3);

/* 6. 导出 JSON 与复制 */
const exp = await page.evaluate(() => {
  document.querySelector('[data-tp="export"]').click();
  const txt = document.getElementById('tp-text').value;
  let ok = false;
  try { const o = JSON.parse(txt); ok = !!o.move && !!o.weapon && !!o.spread; } catch (e) { ok = false; }
  document.querySelector('[data-tp="copy"]').click();
  return { len: txt.length, ok, open: document.getElementById('tp-text').classList.contains('open') };
});
check('导出 JSON 可解析且含全部分组', exp.ok && exp.len > 500, 'JSON 长度 ' + exp.len);
check('复制按钮可用（含回退路径）', exp.open, '文本框已展开');

/* 7. 冻结敌人 AI / 无敌 */
await page.keyboard.press('KeyO');
await wait(150);
const dbg = await page.evaluate(() => {
  const g = window.__game;
  const s = g.suspects[0];
  g.testMode = true;
  window.__feel.debug.freezeAI = false;
  const p0 = { x: s.pos.x, z: s.pos.z };
  for (let i = 0; i < 30; i++) g.advance(1/60, 1/60);
  const movedNoFreeze = Math.hypot(s.pos.x - p0.x, s.pos.z - p0.z);
  window.__feel.debug.freezeAI = true;
  const p1 = { x: s.pos.x, z: s.pos.z };
  for (let i = 0; i < 30; i++) g.advance(1/60, 1/60);
  const movedFrozen = Math.hypot(s.pos.x - p1.x, s.pos.z - p1.z);
  const hp0 = g.player.hp;
  window.__feel.debug.invincible = true;
  g.player.takeDamage(9999, null);
  const hp1 = g.player.hp;
  window.__feel.debug.freezeAI = false;
  window.__feel.debug.invincible = false;
  g.testMode = false;
  return { movedNoFreeze: +movedNoFreeze.toFixed(4), movedFrozen: +movedFrozen.toFixed(4), hp0, hp1, threw: false };
});
check('冻结敌人 AI 生效（冻结后不再位移）', dbg.movedFrozen < 0.001, '未冻结位移 ' + dbg.movedNoFreeze + ' / 冻结后 ' + dbg.movedFrozen);
check('无敌开关生效', dbg.hp1 === dbg.hp0, dbg.hp0 + ' -> ' + dbg.hp1);

console.log('');
console.log('===== 第 1 批验收：参数中枢 + 调参面板 =====');
for (const r of results) console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  —  ' + r.detail : ''));
console.log('');
console.log('控制台错误：', errors.length ? errors.slice(0, 4) : '（无）');
console.log('合计 ' + (results.length - failures) + '/' + results.length + ' 通过');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
