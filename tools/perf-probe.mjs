/* ============================================================
   tools/perf-probe.mjs — performance and resource regression probe
   ------------------------------------------------------------
   Not a pass/fail test but a **comparable quantitative baseline**:
   per-frame DOM mutations, layout reads and logic time, plus GPU resource growth across
   repeated deploys. Use it to prove an optimisation really works rather than going by feel.

   Usage:
     node tools/perf-probe.mjs               # print current metrics
     node tools/perf-probe.mjs --json        # machine-readable, for before/after comparison
     node tools/perf-probe.mjs --save a.json # save as baseline
     node tools/perf-probe.mjs --diff a.json # compare with baseline (non-zero exit on regression)
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Suite } from './harness.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const saveIdx = argv.indexOf('--save');
const diffIdx = argv.indexOf('--diff');
const saveTo = saveIdx >= 0 ? argv[saveIdx + 1] : null;
const diffFrom = diffIdx >= 0 ? argv[diffIdx + 1] : null;

const suite = new Suite('perf-probe', { failOnPageError: true });
const server = await suite.serve({ port: 8251 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await suite.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto('http://127.0.0.1:8251/?deploy=1&pos=0,-30&yaw=0', { waitUntil: 'load' });
await wait(2800);

/* ---------------- Per-frame DOM / layout metering ---------------- */
await page.evaluate(() => {
  const g = window.__game;
  g.testMode = false;                 // must run the real main loop, or per-frame cost can't be measured
  const m = window.__perf = {
    frames: 0, domRecords: 0, layoutReads: 0,
    domByType: { childList: 0, attributes: 0, characterData: 0 },
  };

  /* DOM mutations: observe the whole #hud subtree */
  const hud = document.getElementById('hud');
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      m.domRecords++;
      m.domByType[r.type] = (m.domByType[r.type] || 0) + 1;
    }
  });
  mo.observe(hud, { childList: true, subtree: true, attributes: true, characterData: true });
  m._mo = mo;

  /* layout reads: intercept the clientWidth / clientHeight / getBoundingClientRect getters */
  const count = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get() { m.layoutReads++; return d.get.call(this); },
    });
  };
  count(Element.prototype, 'clientWidth');
  count(Element.prototype, 'clientHeight');
  const gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...a) { m.layoutReads++; return gbcr.apply(this, a); };

  /* frame counter */
  const tick = () => { m.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await wait(7000);

const perFrame = await page.evaluate(() => {
  const m = window.__perf, g = window.__game;
  const f = Math.max(1, m.frames);
  m._mo.disconnect();
  return {
    frames: m.frames,
    domPerFrame: +(m.domRecords / f).toFixed(2),
    layoutReadsPerFrame: +(m.layoutReads / f).toFixed(2),
    domByType: m.domByType,
    logicAvgMs: +g.perf.logicAvg.toFixed(2),
    logicMaxMs: +g.perf.logicMax.toFixed(2),
    fps: +g.perf.fps.toFixed(1),
  };
});

/* ---------------- GPU resources: growth across repeated deploys ---------------- */
const gpu = await page.evaluate(async () => {
  const g = window.__game;
  const info = g.renderer.info;
  const snap = () => ({
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : -1,
  });
  /* snapshot after each deploy: steady-state leaks are measured as the delta between consecutive deploys,
     so the first deploy's one-off initialisation isn't counted as a per-deploy leak. */
  const series = [snap()];
  for (let i = 0; i < 5; i++) {
    g.deploy(g.loadout);
    await new Promise((r) => setTimeout(r, 350));
    series.push(snap());
  }
  const steps = [];
  for (let i = 1; i < series.length; i++) {
    steps.push({
      dg: series[i].geometries - series[i - 1].geometries,
      dt: series[i].textures - series[i - 1].textures,
      dp: series[i].programs - series[i - 1].programs,
    });
  }
  const tail = steps.slice(2);            // drop the first two (they still include lazy init)
  const avg = (k) => tail.length ? +(tail.reduce((s, x) => s + x[k], 0) / tail.length).toFixed(1) : 0;
  const before = series[0], after = series[series.length - 1];
  return {
    before, after, series, steps,
    dGeometries: after.geometries - before.geometries,
    dTextures: after.textures - before.textures,
    dPrograms: after.programs - before.programs,
    perDeploy: { geometries: avg('dg'), textures: avg('dt') },
  };
});

/* ---------------- WebGL resource object counts (framebuffers etc.) ---------------- */
const glCounts = await page.evaluate(() => {
  const g = window.__game;
  const gl = g.renderer.getContext();
  const counts = { framebuffers: 0, textures: 0, buffers: 0 };
  const patch = (name, key) => {
    const orig = gl[name].bind(gl);
    // count creations only; deletions are counted by deleteX
    gl[name] = function (...a) { counts[key]++; return orig(...a); };
  };
  let deleted = 0;
  const origDel = gl.deleteFramebuffer.bind(gl);
  gl.deleteFramebuffer = function (...a) { deleted++; return origDel(...a); };
  patch('createFramebuffer', 'framebuffers');
  const t0 = { ...counts };
  for (let i = 0; i < 3; i++) g.deploy(g.loadout);
  return { created: counts.framebuffers - t0.framebuffers, deleted, over3Deploys: counts.framebuffers };
});

const result = { perFrame, gpu, glCounts };

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('');
  console.log('===== perf-probe =====');
  console.log('DOM mutations / frame : ' + perFrame.domPerFrame + '  ' + JSON.stringify(perFrame.domByType));
  console.log('layout reads / frame  : ' + perFrame.layoutReadsPerFrame);
  console.log('logic avg / peak      : ' + perFrame.logicAvgMs + ' / ' + perFrame.logicMaxMs + ' ms');
  console.log('sampled frames        : ' + perFrame.frames);
  console.log('GPU growth, 5 deploys : geometries ' + gpu.dGeometries +
    ' / textures ' + gpu.dTextures + ' / programs ' + gpu.dPrograms);
  console.log('  steady per deploy (last 3): ' + JSON.stringify(gpu.perDeploy));
  console.log('  per-step delta [geo,tex]  : ' + JSON.stringify(gpu.steps.map(x=>[x.dg,x.dt])));
  console.log('  absolute [geo,tex] series : ' + JSON.stringify(gpu.series.map(x=>[x.geometries,x.textures])));
  console.log('FBOs created/deleted, 3 deploys: ' + glCounts.created + ' / ' + glCounts.deleted);
}

if (saveTo) {
  writeFileSync(saveTo, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.error('[perf-probe] baseline saved: ' + saveTo);
}

if (diffFrom) {
  if (!existsSync(diffFrom)) {
    console.error('[perf-probe] baseline file not found: ' + diffFrom);
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(diffFrom, 'utf8'));
  /* Each metric states which direction is better: FBO deletions higher is better, everything else lower.
     Logic time is very noisy under swiftshader (few sampled frames), so it gets a wider tolerance. */
  const rows = [
    ['DOM mutations / frame', base.perFrame.domPerFrame, perFrame.domPerFrame, 'lower', 0.10],
    ['layout reads / frame', base.perFrame.layoutReadsPerFrame, perFrame.layoutReadsPerFrame, 'lower', 0.10],
    ['geometries per deploy', base.gpu.perDeploy.geometries, gpu.perDeploy.geometries, 'lower', 0.10],
    ['textures per deploy', base.gpu.perDeploy.textures, gpu.perDeploy.textures, 'lower', 0.10],
    ['FBOs created, 3 deploys', base.glCounts.created, glCounts.created, 'lower', 0.10],
    ['FBOs deleted, 3 deploys', base.glCounts.deleted, glCounts.deleted, 'higher', 0.10],
    ['logic time (avg, reference only)', base.perFrame.logicAvgMs, perFrame.logicAvgMs, 'lower', 0.60],
  ];
  console.log('');
  console.log('===== Compared with baseline =====');
  let regress = 0;
  for (const [name, b, n, better, tol] of rows) {
    const delta = n - b;
    const pct = b !== 0 ? (delta / Math.abs(b)) * 100 : (n === 0 ? 0 : Infinity);
    const worse = better === 'lower' ? (n > b * (1 + tol) + 1e-9) : (n < b * (1 - tol) - 1e-9);
    const improved = better === 'lower' ? (n < b * (1 - tol)) : (n > b * (1 + tol));
    if (worse && !name.includes('reference only')) regress++;
    const tag = worse ? '[REGRESSED]' : (improved ? '[IMPROVED]' : '[SAME]');
    console.log(tag + ' ' + name.padEnd(24) + b + ' -> ' + n +
      '  (' + (Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : 'n/a') + ')');
  }
  console.log(regress ? '[RESULT] FAIL (' + regress + ' regressions)' : '[RESULT] PASS');
  await browser.close();
  await server.close();
  process.exit(regress ? 1 : 0);
}

await browser.close();
await server.close();
process.exit(0);
