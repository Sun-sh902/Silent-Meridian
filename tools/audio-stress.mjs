/* ============================================================
   tools/audio-stress.mjs — flashbang stress test (acceptance)
   Fires 20 flashbangs back to back and checks:
     · exactly 20 detonations (guards against a "re-detonate every frame" regression)
     · main-thread logic time (excluding render) stays stable
     · AudioContext count is always 1
     · audio nodes / projectiles / DOM log entries are reclaimed
     · no uncaught errors
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
/* this suite also counts "slow logic frame" warnings as failures */
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'warning' && /SILENT MERIDIAN/.test(t)) suite.pageErrors.push('warn: ' + t);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = suite.results;
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8201/?deploy=1&pos=0,-30&yaw=0', { waitUntil: 'load' });
await wait(2500);

// baseline
const base = await page.evaluate(() => ({
  audio: window.__game.audio.stats(),
  nodes: window.__game.actors.length,
  domNodes: document.getElementsByTagName('*').length,
  heap: performance.memory ? performance.memory.usedJSHeapSize : null,
}));
check('exactly 1 AudioContext', base.audio.ctxCount === 1, 'ctxCount=' + base.audio.ctxCount);
check('noise buffer ready', base.audio.noiseReady, 'noiseReady=' + base.audio.noiseReady);

// control group: no projectiles, same number of frames, as the environment baseline
await page.evaluate(() => {
  const p = window.__game.perf;
  p.logicMax = 0; p.logicSum = 0; p.frames = 0; p.stalls = 0; p.worstGap = 0;
});
for (let i = 0; i < 60; i++) {
  await wait(200);
  if (await page.evaluate(() => window.__game.perf.frames) >= 40) break;
}
const control = await page.evaluate(() => ({ ...window.__game.perf }));

// reset perf counters, then fire 20 flashbangs back to back
await page.evaluate(() => {
  const g = window.__game;
  g.perf.logicMax = 0; g.perf.logicSum = 0; g.perf.frames = 0; g.perf.stalls = 0; g.perf.worstGap = 0;
  g.player.gadgetDef = Object.assign({}, g.player.gadgetDef, { id: 'flash', fuse: 1.5, radius: 13 });
  g.player.gadgetCount = 40;
  for (let i = 0; i < 20; i++) {
    setTimeout(() => g.player.throwGadget(1), i * 130);
  }
});

// wait until all have detonated and no projectile remains
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

check('all 20 throws detonated', after.thrown >= 20 && after.det >= 20, `thrown=${after.thrown} detonated=${after.det}`);
check('no runaway detonations (no per-frame retrigger)', after.det <= 21, 'detonated=' + after.det + ' (expect <=21)');
check('no projectiles left on the field', after.proj === 0, 'projectiles=' + after.proj);
check('peak main-thread logic per frame < 50ms', after.perf.logicMax < 50,
  `logicMax=${after.perf.logicMax.toFixed(1)}ms avg=${after.perf.logicAvg.toFixed(2)}ms frames=${after.perf.frames}`);
check('average main-thread logic < 16ms', after.perf.logicAvg < 16, `avg=${after.perf.logicAvg.toFixed(2)}ms`);
check('flashbangs add no per-frame logic cost (vs control)',
  after.perf.logicAvg - control.logicAvg < 3,
  `control ${control.logicAvg.toFixed(2)}ms → stress ${after.perf.logicAvg.toFixed(2)}ms`);
check('AudioContext still exactly 1', after.audio.ctxCount === 1, 'ctxCount=' + after.audio.ctxCount);
check('audio nodes reclaimed (no more than 40)', after.audio.liveNodes <= 40, 'liveNodes=' + after.audio.liveNodes);
check('DOM log not piling up', after.logItems <= 7, 'log-item=' + after.logItems);
check('whiteout overlay faded out', parseFloat(after.whiteout) === 0, 'opacity=' + after.whiteout);
/* page errors are no longer an ordinary assertion; Suite counts them as failures (stricter) */
if (base.heap && after.heap) {
  const growMB = (after.heap - base.heap) / 1048576;
  check('JS heap growth < 25MB (reference only)', growMB < 25, growMB.toFixed(1) + ' MB');
}

console.log('\n===== Flashbang stress test (20 in a row) =====');
for (const r of results) console.log(`${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
console.log('\nPhase stats:');
console.log('  frames during trigger      :', after.perf.frames);
console.log('  logic avg / peak           :', after.perf.logicAvg.toFixed(2), '/', after.perf.logicMax.toFixed(1), 'ms');
console.log('  worst frame gap (w/ render):', after.perf.worstGap.toFixed(0), 'ms (software rendering, reference only)');
console.log('  control (no throws)        : logic/frame', control.logicAvg.toFixed(2), 'ms · peak', control.logicMax.toFixed(1), 'ms · frames', control.frames);
console.log('  → logic delta per frame    :', (after.perf.logicAvg - control.logicAvg).toFixed(2), 'ms (the environment-independent, trustworthy metric)');
console.log('  (frame gaps swing wildly under software rendering; this run control', control.worstGap.toFixed(0), 'ms vs stress', after.perf.worstGap.toFixed(0), 'ms, no conclusion drawn)');
console.log('  duplicate sounds gated     :', after.audio.gated);
console.log('  live audio nodes           :', base.audio.liveNodes, '→', after.audio.liveNodes);
console.log('  DOM nodes                  :', base.domNodes, '→', after.domNodes);
if (base.heap && after.heap) console.log('  JS heap                    :', (base.heap / 1048576).toFixed(1), '→', (after.heap / 1048576).toFixed(1), 'MB');
await suite.finish();
