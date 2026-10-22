/* ============================================================
   tools/audio-stress.mjs — flashbang stress test (acceptance)
   Triggers 20 flashbangs in a row and checks:
     · Whether the detonation count is exactly 20 (guards against "detonating every frame" regressions)
     · Whether main-thread logic time (excluding rendering) stays stable
     · Whether the AudioContext count stays at 1
     · Whether audio nodes / projectiles / DOM log are reclaimed
     · Whether any uncaught exceptions occur
   Usage: node tools/audio-stress.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('audio-stress');
const server = await suite.serve({ port: 8201 });

const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--js-flags=--expose-gc'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await suite.newPage();
/* This suite additionally treats warnings such as "abnormal single-frame logic time" as failures */
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'warning' && /SILENT MERIDIAN/.test(t)) suite.pageErrors.push('warn: ' + t);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = suite.results;
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8201/?deploy=1&pos=0,-30&yaw=0', { waitUntil: 'load' });
await wait(2500);

// Baseline
const base = await page.evaluate(() => ({
  audio: window.__game.audio.stats(),
  nodes: window.__game.actors.length,
  domNodes: document.getElementsByTagName('*').length,
  heap: performance.memory ? performance.memory.usedJSHeapSize : null,
}));
check('Exactly one AudioContext', base.audio.ctxCount === 1, 'ctxCount=' + base.audio.ctxCount);
check('Noise buffer is ready', base.audio.noiseReady, 'noiseReady=' + base.audio.noiseReady);

// Control group: throw nothing, collect the same number of frames as an "environmental baseline"
await page.evaluate(() => {
  const p = window.__game.perf;
  p.logicMax = 0; p.logicSum = 0; p.frames = 0; p.stalls = 0; p.worstGap = 0;
});
for (let i = 0; i < 60; i++) {
  await wait(200);
  if (await page.evaluate(() => window.__game.perf.frames) >= 40) break;
}
const control = await page.evaluate(() => ({ ...window.__game.perf }));

// Reset performance timers and start 20 consecutive flashbangs
await page.evaluate(() => {
  const g = window.__game;
  g.perf.logicMax = 0; g.perf.logicSum = 0; g.perf.frames = 0; g.perf.stalls = 0; g.perf.worstGap = 0;
  g.player.gadgetDef = Object.assign({}, g.player.gadgetDef, { id: 'flash', fuse: 1.5, radius: 13 });
  g.player.gadgetCount = 40;
  for (let i = 0; i < 20; i++) {
    setTimeout(() => g.player.throwGadget(1), i * 130);
  }
});

// Wait until everything has detonated and no projectiles remain
let settled = false;
for (let i = 0; i < 120; i++) {
  await wait(500);
  const s = await page.evaluate(() => ({
    det: window.__game.stats.detonations,
    proj: window.__game.projectiles.length,
    thrown: window.__game.stats.gadgets,
  }));
  if (s.thrown >= 20 && s.det >= 20 && s.proj === 0) { settled = true; break; }
}
await wait(2500);   // let tails finish and nodes be reclaimed

const after = await page.evaluate(() => ({
  det: window.__game.stats.detonations,
  thrown: window.__game.stats.gadgets,
  proj: window.__game.projectiles.length,
  perf: { ...window.__game.perf },
  audio: window.__game.audio.stats(),
  domNodes: document.getElementsByTagName('*').length,
  logItems: document.querySelectorAll('.log-item').length,
  whiteout: getComputedStyle(document.getElementById('whiteout')).opacity,
  heap: performance.memory ? performance.memory.usedJSHeapSize : null,
}));

check('All 20 throws detonate', after.thrown >= 20 && after.det >= 20, `thrown=${after.thrown} detonated=${after.det}`);
check('Detonation count does not explode (no per-frame retriggering)', after.det <= 21, 'detonated=' + after.det + ' (expected <=21)');
check('No leftover projectiles', after.proj === 0, 'projectiles=' + after.proj);
check('Main-thread peak single-frame logic time < 50ms', after.perf.logicMax < 50,
  `logicMax=${after.perf.logicMax.toFixed(1)}ms avg=${after.perf.logicAvg.toFixed(2)}ms frames=${after.perf.frames}`);
check('Main-thread average logic time < 16ms', after.perf.logicAvg < 16, `avg=${after.perf.logicAvg.toFixed(2)}ms`);
check('Flashbangs add no per-frame logic cost (vs control group)',
  after.perf.logicAvg - control.logicAvg < 3,
  `control ${control.logicAvg.toFixed(2)}ms → stress ${after.perf.logicAvg.toFixed(2)}ms`);
check('AudioContext is still 1', after.audio.ctxCount === 1, 'ctxCount=' + after.audio.ctxCount);
check('Audio nodes reclaimed (no more than 40)', after.audio.liveNodes <= 40, 'liveNodes=' + after.audio.liveNodes);
check('DOM log did not pile up', after.logItems <= 7, 'log-item=' + after.logItems);
check('Whiteout overlay has faded', parseFloat(after.whiteout) === 0, 'opacity=' + after.whiteout);
/* Page errors are no longer ordinary assertions; Suite counts them as failures centrally (a stronger constraint) */
if (base.heap && after.heap) {
  const growMB = (after.heap - base.heap) / 1048576;
  check('JS heap growth < 25MB (informational only)', growMB < 25, growMB.toFixed(1) + ' MB');
}

console.log('\n===== Flashbang stress test (20 consecutive) =====');
for (const r of results) console.log(`${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
console.log('\nPhase statistics:');
console.log('  Frames during burst :', after.perf.frames);
console.log('  Logic time avg/peak :', after.perf.logicAvg.toFixed(2), '/', after.perf.logicMax.toFixed(1), 'ms');
console.log('  Worst frame gap (with rendering):', after.perf.worstGap.toFixed(0), 'ms (software-rendered; informational only)');
console.log('  Control (no throws) : per-frame logic', control.logicAvg.toFixed(2), 'ms · peak', control.logicMax.toFixed(1), 'ms · frames', control.frames);
console.log('  -> per-frame logic delta:', (after.perf.logicAvg - control.logicAvg).toFixed(2), 'ms (the trustworthy, environment-independent metric)');
console.log('  (frame gaps fluctuate wildly under software rendering: control', control.worstGap.toFixed(0), 'ms vs stress', after.perf.worstGap.toFixed(0), 'ms; no conclusion drawn)');
console.log('  Suppressed duplicate sounds:', after.audio.gated);
console.log('  Live audio nodes    :', base.audio.liveNodes, '→', after.audio.liveNodes);
console.log('  DOM nodes           :', base.domNodes, '→', after.domNodes);
if (base.heap && after.heap) console.log('  JS heap             :', (base.heap / 1048576).toFixed(1), '→', (after.heap / 1048576).toFixed(1), 'MB');
await suite.finish();
