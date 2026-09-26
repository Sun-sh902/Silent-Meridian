/* ============================================================
   tools/fixes-test.mjs — 四个 Bug 的专项验收
     1) 备战界面不应有环境背景声
     2) 面向队友时目标卡显示为队友
     3) 友军伤害已关闭（但平民仍可被误伤，ROE 保留）
     4) 地图：敌人=橙点、事件=黄点、主角与队友=蓝
   用法： node tools/fixes-test.mjs
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
await new Promise((r) => server.listen(8204, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n = 2) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const step = () => { if (++i >= k) res(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);
let failures = 0;
const results = [];
function check(name, ok, detail) {
  if (!ok) failures++;
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
}

/* ============ 1. 备战界面环境声 ============ */
await page.goto('http://127.0.0.1:8204/', { waitUntil: 'load' });
await wait(800);

await page.evaluate(() => window.__game.screens.show('loadout'));
await wait(300);
await page.click('#primary-list .pick[data-id="k9"]');   // 该操作会 init() 音频
await wait(400);

let a = await page.evaluate(() => ({
  ctxCount: window.__game.audio.stats().ctxCount,
  state: window.__game.audio.ctx ? window.__game.audio.ctx.state : 'none',
  rain: !!window.__game.audio.rainNodes,
  ambience: !!window.__game.audio._ambience,
}));
check('备战界面：音频上下文已建立（按钮音效可用）', a.ctxCount === 1, `ctxCount=${a.ctxCount} state=${a.state}`);
check('备战界面：没有环境背景声（雨声未启动）', a.rain === false && a.ambience === false,
  `rainNodes=${a.rain} ambience=${a.ambience}`);

await page.click('#btn-deploy');
await wait(2600);
a = await page.evaluate(() => ({
  rain: !!window.__game.audio.rainNodes,
  ambience: !!window.__game.audio._ambience,
}));
check('进入行动：环境声已开启', a.rain === true && a.ambience === true, `rainNodes=${a.rain}`);

/* ============ 2. 面向队友 → 显示为队友 ============ */
await page.evaluate(() => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0; g.player.pitch = 0;
  g.player.ads = 1;
  const m = g.squad[0];
  m.pos.x = 0; m.pos.z = -6;              // 正前方 6 米
  m.y = 0;
  g.suspects.forEach((s) => { s.pos.x = 200; s.pos.z = 200; });
  g.civilians.forEach((c) => { c.pos.x = 200; c.pos.z = 200; });
});
await frames(3);
await wait(500);
const friend = await page.evaluate(() => {
  const g = window.__game;
  const card = document.querySelector('#target-card');
  return {
    kind: g.observeTarget ? g.observeTarget.kind : null,
    ident: g.observeTarget ? g.observeTarget.ident : null,
    hidden: card.classList.contains('hidden'),
    cls: card.className,
    title: document.querySelector('#tc-class').textContent.trim(),
    note: document.querySelector('#tc-note').textContent.trim(),
    callsign: g.squad[0].callsign,
  };
});
check('面向队友：目标卡被判定为友军', friend.kind === 'squad' && friend.ident === 1,
  `kind=${friend.kind} ident=${friend.ident}`);
check('面向队友：显示呼号而非 UNKNOWN CONTACT', !friend.hidden && friend.cls.includes('friendly') &&
  friend.title === friend.callsign, `“${friend.title}” class=${friend.cls}`);

/* ============ 3. 友军伤害已关闭 ============ */
const ff = await page.evaluate(async () => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0; g.player.pitch = 0;
  const mate = g.squad[1];
  mate.pos.x = 0; mate.pos.z = -5;
  const foe = g.suspects[0];
  foe.pos.x = 0; foe.pos.z = -11; foe.hp = foe.maxHp; foe.alive = true;
  const civ = g.civilians[0];
  civ.pos.x = 200; civ.pos.z = 200;          // 先移出射线，单独验证
  const before = { mate: mate.hp, foe: foe.hp, civ: civ.hp };
  g.player.mag.primary = 30; g.player.reloading = 0;
  for (let i = 0; i < 5; i++) { g.player.fireCd = 0; g.player.recoil.pitch = 0; g.player.recoil.yaw = 0; g.player.fireOnce(); }
  const afterMate = { mate: mate.hp, foe: foe.hp };

  // 场景二：把平民放到枪口正前方（队友与敌人让开），验证 ROE 仍然生效
  mate.pos.x = 200; mate.pos.z = 200;
  foe.pos.x = 200; foe.pos.z = 200;
  civ.pos.x = 0; civ.pos.z = -6; civ.hp = civ.maxHp; civ.alive = true;
  const civBefore = civ.hp;
  g.player.mag.primary = 30;
  for (let i = 0; i < 5; i++) { g.player.fireCd = 0; g.player.recoil.pitch = 0; g.player.recoil.yaw = 0; g.player.fireOnce(); }
  return { before, afterMate, civBefore, civAfter: civ.hp };
});
check('友军伤害：挡在枪口前的队友未掉血', ff.afterMate.mate === ff.before.mate,
  `队友 HP ${ff.before.mate} → ${ff.afterMate.mate}`);
check('子弹穿过队友后仍能命中敌人', ff.afterMate.foe < ff.before.foe,
  `敌人 HP ${ff.before.foe} → ${ff.afterMate.foe}`);
check('平民仍可被误伤（交战规则未被破坏）', ff.civAfter < ff.civBefore,
  `平民 HP ${ff.civBefore} → ${ff.civAfter}`);

const guard = await page.evaluate(() => {
  const g = window.__game;
  const mate = g.squad[2];
  const hp = mate.hp;
  mate.takeDamage(50, g.player);           // 直接走伤害入口，验证兜底拦截
  return { hp, after: mate.hp };
});
check('友军伤害：伤害入口兜底拦截生效', guard.after === guard.hp, `HP ${guard.hp} → ${guard.after}`);

/* ============ 4. 地图配色与事件点 ============ */
const map = await page.evaluate(() => {
  const g = window.__game;
  g.mapEvents.length = 0;
  g.onSuspectAlerted(g.suspects[0], { x: 0, y: 1.5, z: 0 });     // 警讯 → 黄
  g.civilianCall(g.civilians[1]);                                 // 发现平民 → 黄
  g.onObjectiveTaken('manifest', g.objectiveProps.manifest);      // 情报 → 黄
  g.toggleTacMap();
  return {
    events: g.mapEvents.map((e) => e.kind + ':' + e.label),
    legend: document.querySelector('.tm-legend').innerText.replace(/\s+/g, ' ').trim(),
    colors: { enemy: '#ff9a3c', event: '#ffd447', friendly: '#4ea8ff' },
  };
});
check('地图事件点已记录（黄色）', map.events.length >= 3, map.events.join(' | '));
check('图例已更新为 蓝/橙/黄 配色', /蓝/.test(map.legend) && /橙/.test(map.legend) && /黄/.test(map.legend),
  map.legend.slice(0, 80));

const colors = await page.evaluate(() => {
  const sw = (n) => getComputedStyle(document.querySelector('.sw.' + n)).backgroundColor;
  return { suspect: sw('suspect'), event: sw('event'), self: sw('self') };
});
check('图例色块：敌人=橙 / 事件=黄 / 友军=蓝',
  colors.suspect === 'rgb(255, 154, 60)' && colors.event === 'rgb(255, 212, 71)' && colors.self === 'rgb(78, 168, 255)',
  JSON.stringify(colors));

const tacrender = await page.evaluate(() => {
  try { window.__game.tacmap.render(); return 'ok'; } catch (e) { return 'error: ' + e.message; }
});
check('战术地图渲染无异常（含事件层）', tacrender === 'ok', tacrender);

/* ============ 5. 撤离行动后环境声应停止 ============ */
const off = await page.evaluate(() => {
  const g = window.__game;
  g.toggleTacMap();
  g.abort();
  return { rain: !!g.audio.rainNodes, ambience: !!g.audio._ambience };
});
check('返回主菜单：环境声已停止', off.rain === false && off.ambience === false,
  `rainNodes=${off.rain} ambience=${off.ambience}`);

console.log('\n===== 四个 Bug 专项验收 =====');
for (const r of results) console.log(`${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
console.log('\n控制台错误：', errors.length ? errors.slice(0, 5) : '（无）');
console.log(`\n合计 ${results.length - failures}/${results.length} 通过`);

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
