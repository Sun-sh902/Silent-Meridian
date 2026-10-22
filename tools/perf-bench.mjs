/* ============================================================
   tools/perf-bench.mjs — low-variance performance benchmark (suitable for A/B comparison)
   ------------------------------------------------------------
   Division of labor with perf-probe.mjs:
     · perf-probe  — steady-state "cost" profile (per-frame DOM/layout/GPU resource growth)
     · perf-bench  — pure logic throughput and draw-call counts, low variance, good for before/after

   Why a pure-logic benchmark:
     Under headless + swiftshader the frame rate is in the single digits and rAF frame time is dominated by software rasterization,
     creating enormous noise that hides logic-layer optimizations. This script freezes rAF with ?test=1
     and drives advance() manually at a fixed timestep, so almost everything measured is CPU logic time.
     Each scenario runs multiple rounds and takes the median, further suppressing jitter.

   Usage:
     node tools/perf-bench.mjs                 # print results
     node tools/perf-bench.mjs --json          # machine-readable
     node tools/perf-bench.mjs --save a.json
     node tools/perf-bench.mjs --diff a.json   # non-zero exit on regression
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Suite, ROOT as root } from './harness.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const saveTo = argv.includes('--save') ? argv[argv.indexOf('--save') + 1] : null;
const diffFrom = argv.includes('--diff') ? argv[argv.indexOf('--diff') + 1] : null;

const STEPS = 900;        // fixed steps per scenario (15 seconds of simulated time)
const ROUNDS = 9;         // number of rounds
/* The primary metric is the "fastest round" rather than the median:
   in a CPU microbenchmark the minimum is least affected by system interference and is a more stable estimator;
   the median is kept in the output for reference. Measured reruns of the same code in a fresh process still drift about ±15%,
   so only differences clearly larger than that are trustworthy (the diff tolerance is set accordingly). */

const suite = new Suite('perf-bench', { failOnPageError: true });
const server = await suite.serve({ port: 8301 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await suite.newPage();
await page.goto('http://127.0.0.1:8301/?deploy=1&test=1&pos=0,-30&yaw=0', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2800));

/* ---------------- Pure logic throughput ---------------- */
const logic = await page.evaluate(({ STEPS, ROUNDS }) => {
  const g = window.__game;
  const P = g.player;
  const DT = 1 / 60;
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };

  const resetScene = () => {
    g.input.keys.clear();
    g.input.lmb = false; g.input.lmbPressed = false; g.input.rmb = false;
    P.pos.x = 0; P.pos.z = -30; P.yaw = 0; P.pitch = 0;
    P.ads = 0; P.reloading = 0; P.fireCd = 0; P.healthRegen = 0;
    P.hp = P.maxHp; P.alive = true;
    P.mag.primary = 9999; P.reserve.primary = 9999;
    g.squad.forEach((m, i) => { m.pos.x = i * 1.6; m.pos.z = -28; m.path = null; m.alive = true; m.hp = m.maxHp; });
    g.suspects.forEach((s, i) => { s.pos.x = 999 + i; s.pos.z = 999; s.alive = true; });
    g.civilians.forEach((c, i) => { c.pos.x = 999 + i; c.pos.z = 999; });
    g.squadOrder = 'follow'; g.squadWaypoint = null;
    g.alarmRaised = false; g.weaponsFree = false;
  };

  const bench = (label, setup) => {
    /* Run one untimed round first so the JIT compiles the hot paths */
    resetScene(); setup();
    for (let i = 0; i < STEPS; i++) g.advance(DT, DT);
    const times = [];
    for (let r = 0; r < ROUNDS; r++) {
      resetScene();
      setup();
      const t0 = performance.now();
      for (let i = 0; i < STEPS; i++) g.advance(DT, DT);
      times.push(performance.now() - t0);
    }
    const best = Math.min(...times), m = med(times);
    return { label, ms: +best.toFixed(3), medianMs: +m.toFixed(3),
             usPerStep: +((best * 1000) / STEPS).toFixed(2) };
  };

  const out = [];

  /* A. Idle: squad follows in formation (the most common state) */
  out.push(bench('idle-follow', () => {}));

  /* B. Move and clear: everyone advances along paths + bounding overwatch switching */
  out.push(bench('clear-order', () => {
    g.squad.forEach((m) => { m.pos.x = 0; m.pos.z = -34; m.path = null; m.pathAge = 2; });
    g.issueClearAt(0, 20);
  }));

  /* C. Engagement: all 9 suspects alerted and firing continuously (heaviest perception + ballistics + effects state) */
  out.push(bench('engage-9', () => {
    g.raiseAlarm('bench');
    g.suspects.forEach((s, i) => {
      s.alive = true; s.hp = s.maxHp; s.morale = 1;
      const a = (i / 9) * Math.PI * 2;
      s.pos.x = Math.cos(a) * 14; s.pos.z = -30 + Math.sin(a) * 14;
      s.awareness = 1; s.alerted = true; s.state = 'engage'; s.target = P;
      s.fireCd = 0; s.burstLeft = 3;
    });
    g.weaponsFree = true;
    g.input.lmb = true;
    P.mag.primary = 9999; P.reserve.primary = 9999;
  }));

  /* D. Squad firing + full-auto shooting (the most allocation-heavy ballistics/effects path) */
  out.push(bench('squad-firing', () => {
    g.weaponsFree = true;
    g.input.lmb = true;
    g.squad.forEach((m, i) => { m.pos.x = i * 1.6 - 3; m.pos.z = -26; m.aimTarget = null; });
    g.suspects.forEach((s, i) => {
      s.alive = true; s.hp = s.maxHp;
      s.pos.x = -6 + i * 1.5; s.pos.z = 6;
      s.awareness = 1; s.alerted = true; s.state = 'engage'; s.target = P;
    });
  }));

  /* HUD timed separately: advance() calls ui.update() internally,
     and the HUD's DOM/layout cost is exactly the main battleground of this optimization.
     Only a separate measurement can separate "HUD cost" from "game logic cost"; otherwise attribution is impossible. */
  resetScene();
  for (let i = 0; i < STEPS; i++) g.ui.update(DT, g);      // warm-up
  const hudTimes = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < STEPS; i++) g.ui.update(DT, g);
    hudTimes.push(performance.now() - t0);
  }
  const hudMs = Math.min(...hudTimes);
  out.push({ label: 'hud-update-only', ms: +hudMs.toFixed(3), medianMs: +med(hudTimes).toFixed(3),
             usPerStep: +((hudMs * 1000) / STEPS).toFixed(2) });

  return out;
}, { STEPS, ROUNDS });

/* ---------------- Draw calls / triangles ---------------- */
/* Key point: the logic benchmark teleported actors to 999 (far beyond far=420); measuring rendering straight afterwards
   would frustum-cull almost the whole scene, leaving only a dozen draw calls — empty-scene numbers.
   So redeploy first, returning to a real mission state, then scan view angles. */
await page.evaluate(() => {
  const g = window.__game;
  g.input.keys.clear(); g.input.lmb = false; g.input.lmbPressed = false;
  g.testMode = false;
  g.deploy(g.loadout);
});
await new Promise((r) => setTimeout(r, 3000));
const draw = await page.evaluate(async () => {
  const g = window.__game;
  const info = g.renderer.info;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const max = (a) => Math.max(...a);

  /* Trap: Game.loop() calls renderer.render() twice per frame —
     first the main scene, then viewmodel's private scene. info.autoReset is true,
     so the second render() zeroes the counters; reading info.render.calls directly then gives
     the "weapon" draw calls (a dozen-odd) and completely misses the level.
     Wrap render here and sample only after the main-scene call. */
  const r = g.renderer;
  const origRender = r.render.bind(r);
  let lastMain = { calls: 0, triangles: 0 };
  r.render = function (scene, cam) {
    const out = origRender(scene, cam);
    if (scene === g.scene) lastMain = { calls: info.render.calls, triangles: info.render.triangles };
    return out;
  };

  /* A single view may happen to miss puddles and similar objects, so do a view sweep:
     teleport point by point and sample once settled, looking at both median and peak.
     The peak is most sensitive to changes like "merge 46 puddles" (previously up to 46 transparent draw calls). */
  const VIEWS = [
    [0, -30, 0], [0, -30, Math.PI], [0, 10, Math.PI / 2], [0, 10, -Math.PI / 2],
    [-45, 0, 0.8], [45, 0, -2.3], [0, 40, Math.PI], [-60, -50, 2.6],
  ];
  const calls = [], tris = [];
  for (const [x, z, yaw] of VIEWS) {
    const p = g.player;
    p.pos.x = x; p.pos.z = z; p.yaw = yaw; p.pitch = 0;
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    calls.push(lastMain.calls);
    tris.push(lastMain.triangles);
  }
  r.render = origRender;
  return {
    calls: med(calls), callsMax: max(calls),
    triangles: med(tris), trianglesMax: max(tris),
    views: calls,
    programs: info.programs ? info.programs.length : -1,
    geometries: info.memory.geometries, textures: info.memory.textures,
  };
});

const result = { logic, draw };

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('');
  console.log('===== perf-bench =====');
  console.log('Pure logic (900 fixed steps, median of 7 rounds)');
  for (const r of logic) {
    console.log('  ' + r.label.padEnd(16) + r.ms.toFixed(1).padStart(6) + ' ms(best) / ' +
      r.medianMs.toFixed(1).padStart(6) + ' ms(median)  ' + String(r.usPerStep).padStart(7) + ' µs/step');
  }
  console.log('Rendering');
  console.log('  draw calls  median ' + draw.calls + ' / peak ' + draw.callsMax);
  console.log('  triangles   median ' + draw.triangles + ' / peak ' + draw.trianglesMax);
  console.log('  calls by view ' + JSON.stringify(draw.views));
  console.log('  programs    ' + draw.programs);
  console.log('  geometries  ' + draw.geometries + '   textures ' + draw.textures);
}

if (saveTo) { writeFileSync(saveTo, JSON.stringify(result, null, 2) + '\n', 'utf8'); console.error('[perf-bench] saved: ' + saveTo); }

if (diffFrom) {
  if (!existsSync(diffFrom)) { console.error('Baseline not found: ' + diffFrom); process.exit(2); }
  const base = JSON.parse(readFileSync(diffFrom, 'utf8'));
  console.log('');
  console.log('===== Comparison with baseline (lower is better; cross-process logic-time noise is about ±15%, tolerance 25%) =====');
  let regress = 0;
  const row = (name, b, n, tol) => {
    const pct = b ? ((n - b) / b) * 100 : (n === 0 ? 0 : Infinity);
    const worse = n > b * (1 + tol);
    if (worse) regress++;
    console.log((worse ? '[REGRESSION] ' : (n < b * (1 - tol) ? '[IMPROVED] ' : '[UNCHANGED] ')) +
      name.padEnd(18) + b + ' -> ' + n + '  (' + (Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : 'n/a') + ')');
  };
  for (const r of result.logic) {
    const b = base.logic.find((x) => x.label === r.label);
    if (b) row('logic:' + r.label, b.ms, r.ms, 0.25);   // measured cross-process noise about ±15%, tolerance 25%
  }
  row('draw calls(median)', base.draw.calls, draw.calls, 0.02);
  row('draw calls(peak)', base.draw.callsMax, draw.callsMax, 0.02);
  /* Triangle count and draw-call count are a trade-off: merging meshes reduces draw calls
     but loses per-object frustum culling and raises triangle count. They should not both be failed on "lower is better",
     so triangles are reported only and do not affect the exit code. */
  {
    const b = base.draw.triangles, n = draw.triangles;
    const pct = b ? ((n - b) / b) * 100 : 0;
    console.log('[info] ' + 'triangles(median)'.padEnd(18) + b + ' -> ' + n +
      '  (' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)  — trade-off with draw calls; not counted as failure');
  }
  row('geometries', base.draw.geometries, draw.geometries, 0.10);
  row('textures', base.draw.textures, draw.textures, 0.10);
  console.log(regress ? '[RESULT] FAIL (' + regress + ' regressions)' : '[RESULT] PASS');
  await browser.close(); await server.close();
  process.exit(regress ? 1 : 0);
}

await browser.close();
await server.close();
process.exit(0);
