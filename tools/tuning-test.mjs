/* ============================================================
   tools/tuning-test.mjs - batch 1 acceptance: parameter hub + tuning panel
   Usage: node tools/tuning-test.mjs
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

/* 1. Panel exists, is hidden by default, and has all parameters */
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
check('Panel injected and hidden by default', init.exists && init.hidden, JSON.stringify(init));
/* Reconcile exactly against FEEL_SCHEMA rather than a loose ">= 60" assertion */
const schemaCount = await page.evaluate(() => {
  const items = window.__feelSchema.flatMap((g) => g.items);
  return {
    total: items.length,
    numeric: items.filter((i) => (i[7] || 'num') !== 'bool').length,
    bool: items.filter((i) => i[7] === 'bool').length,
  };
});
check('Slider/toggle counts match the parameter table item by item',
  init.sliders === schemaCount.numeric && init.nums === schemaCount.numeric &&
  init.checks === schemaCount.bool + 3,
  `UI range=${init.sliders} number=${init.nums} checkbox=${init.checks}` +
  ` / parameter table numeric=${schemaCount.numeric} bool=${schemaCount.bool} (checkboxes additionally include 3 toolbar toggles)`);
check('Unwired parameters are clearly marked', init.badges > 0, init.badges + ' marked "NOT WIRED"');

/* 2. P opens: releases the pointer, does not slow time */
await page.keyboard.press('KeyP');
await wait(300);
const opened = await page.evaluate(() => ({
  visible: !document.getElementById('tuning-panel').classList.contains('hidden'),
  locked: !!document.pointerLockElement,
  ts: window.__game.tuning.open,
}));
check('P opens the panel and releases the pointer', opened.visible && !opened.locked, JSON.stringify(opened));

/* 3. Drag a slider -> feel changes immediately -> game behavior changes immediately (measured at a fixed timestep) */
const live = await page.evaluate(() => {
  const g = window.__game;
  const before = window.__feel.move.walkSpeed;
  const input = document.querySelector('#tuning-panel input[data-g="move"][data-k="walkSpeed"]');
  input.value = '6.2';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const after = window.__feel.move.walkSpeed;
  // Measure displacement at a fixed timestep to verify "changing one number takes effect immediately"
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
check('Slider writes to feel take effect immediately', live.before === 3.1 && live.after === 6.2, live.before + ' -> ' + live.after);
check('Measured game speed changes with the speed setting (3.1 -> 6.2)', Math.abs(live.moved - 6.2) < 0.05, 'measured 1 s displacement = ' + live.moved + ' m');
check('Number box and slider stay in sync both ways', live.numBox === '6.2', 'number input = ' + live.numBox);

/* 4. Preset slots A/B/C */
const preset = await page.evaluate(() => {
  const save = (slot) => document.querySelector('[data-tp="preset-save"][data-slot="' + slot + '"]').click();
  const load = (slot) => document.querySelector('[data-tp="preset-load"][data-slot="' + slot + '"]').click();
  const ws = () => window.__feel.move.walkSpeed;
  const seq = [];
  seq.push(['current', ws()]);
  load('A'); seq.push(['load A (original)', ws()]);
  window.__feel.move.walkSpeed = 9;
  save('B'); seq.push(['set 9, save B', ws()]);
  window.__feel.move.walkSpeed = 2;
  load('B'); seq.push(['load B', ws()]);
  load('A'); seq.push(['load A again', ws()]);
  return seq;
});
check('Preset A holds the original value and supports A/B comparison', preset[1][1] === 3.1 && preset[4][1] === 3.1,
  preset.map((p) => p[0] + '=' + p[1]).join(' / '));
check('Preset B can be saved and reloaded', preset[2][1] === 9 && preset[3][1] === 9, JSON.stringify(preset));

/* 5. Read-only overlay mode + [ ] , . adjustment */
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
check('O opens the read-only overlay (without pointer-release logic)', ov.visible, JSON.stringify(ov));
check('[ ] adjusts the selected parameter', ov2.val > ov.val, ov.val + ' -> ' + ov2.val);
check(', . cycles the selected parameter', ov3 !== ov.sel, ov.sel + ' -> ' + ov3);

/* 6. Export JSON and copy */
const exp = await page.evaluate(async () => {
  document.querySelector('[data-tp="export"]').click();
  const txt = document.getElementById('tp-text').value;
  let ok = false;
  try { const o = JSON.parse(txt); ok = !!o.move && !!o.weapon && !!o.spread; } catch (e) { ok = false; }
  const open = document.getElementById('tp-text').classList.contains('open');

  /* --- Success path: stub clipboard.writeText --- */
  let captured = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { captured = t; return Promise.resolve(); } },
  });
  document.querySelector('[data-tp="copy"]').click();
  await new Promise((r) => setTimeout(r, 60));
  const okPath = captured === txt;

  /* --- Failure path: writeText rejects, must fall back to execCommand --- */
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
check('Exported JSON parses and contains every group', exp.ok && exp.len > 500, 'JSON length ' + exp.len);
check('Copy button: success path writes JSON to the clipboard', exp.clip.ok && exp.clip.text === exp.json,
  'clipboard.writeText received ' + exp.clip.text.length + ' chars, matches exported content=' + (exp.clip.text === exp.json));
check('Copy button: falls back when the clipboard is denied', exp.clip.fallbackUsed,
  'execCommand("copy") called=' + exp.clip.fallbackUsed);

/* 7. Freeze enemy AI / invincible */
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
check('Freeze enemy AI works (no movement after freezing)', dbg.movedFrozen < 0.001, 'unfrozen displacement ' + dbg.movedNoFreeze + ' / frozen ' + dbg.movedFrozen);
check('Invincibility toggle works', dbg.hp1 === dbg.hp0, dbg.hp0 + ' -> ' + dbg.hp1);

console.log('');
await suite.finish();
