/* ============================================================
   tools/tuning-test.mjs - 第 1 批验收：参数中枢 + 调参面板
   用法： node tools/tuning-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('tuning-test');
const server = await suite.serve({ port: 8212 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await suite.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = suite.results;
const check = (name, ok, detail) => suite.check(name, ok, detail);

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
/* 与 FEEL_SCHEMA 精确对账，而不是「>= 60」这种宽松断言 */
const schemaCount = await page.evaluate(() => {
  const items = window.__feelSchema.flatMap((g) => g.items);
  return {
    total: items.length,
    numeric: items.filter((i) => (i[7] || 'num') !== 'bool').length,
    bool: items.filter((i) => i[7] === 'bool').length,
  };
});
check('滑块/开关数量与参数表逐项一致',
  init.sliders === schemaCount.numeric && init.nums === schemaCount.numeric &&
  init.checks === schemaCount.bool + 3,
  `画面 range=${init.sliders} number=${init.nums} checkbox=${init.checks}` +
  ` / 参数表 numeric=${schemaCount.numeric} bool=${schemaCount.bool}（checkbox 额外含工具栏 3 个开关）`);
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
const exp = await page.evaluate(async () => {
  document.querySelector('[data-tp="export"]').click();
  const txt = document.getElementById('tp-text').value;
  let ok = false;
  try { const o = JSON.parse(txt); ok = !!o.move && !!o.weapon && !!o.spread; } catch (e) { ok = false; }
  const open = document.getElementById('tp-text').classList.contains('open');

  /* --- 成功路径：桩掉 clipboard.writeText --- */
  let captured = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { captured = t; return Promise.resolve(); } },
  });
  document.querySelector('[data-tp="copy"]').click();
  await new Promise((r) => setTimeout(r, 60));
  const okPath = captured === txt;

  /* --- 失败路径：writeText 拒绝，必须回退到 execCommand --- */
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error('denied')) },
  });
  let fallbackUsed = false;
  const origExec = document.execCommand;
  document.execCommand = () => { fallbackUsed = true; return true; };
  document.querySelector('[data-tp="copy"]').click();
  await new Promise((r) => setTimeout(r, 120));
  const textAfterFallback = document.getElementById('tp-text').value;
  document.execCommand = origExec;

  return { len: txt.length, ok, open, json: txt,
    clip: { ok: okPath, text: captured || '', fallbackUsed, fallbackText: textAfterFallback } };
});
check('导出 JSON 可解析且含全部分组', exp.ok && exp.len > 500, 'JSON 长度 ' + exp.len);
check('复制按钮：成功路径把 JSON 写入剪贴板', exp.clip.ok && exp.clip.text === exp.json,
  'clipboard.writeText 收到 ' + exp.clip.text.length + ' 字符，与导出内容一致=' + (exp.clip.text === exp.json));
check('复制按钮：剪贴板被拒时走降级路径', exp.clip.fallbackUsed,
  'execCommand("copy") 被调用=' + exp.clip.fallbackUsed);

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
await suite.finish();
