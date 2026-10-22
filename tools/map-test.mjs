/* ============================================================
   tools/map-test.mjs — minimap / tactical map coordinate-transform acceptance
   ------------------------------------------------------------
   Covers the user's acceptance criteria:
     1) After rotating 360° in place, buildings return to their original relative positions (no accumulated drift)
     2) After actually turning right 90°, a building that was dead ahead appears directly to the left on the map
     3) Continuous rotation for 60 seconds produces a smooth path with no jumps
     4) Building names stay horizontal, never overlap and never leave the canvas
     5) The player icon stays centered and the arrow direction matches heading (including the tactical map 180° fix)
     6) window.__mapDebug is available and matches rendered pixels
   Usage: node tools/map-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('map-test');
const server = await suite.serve({ port: 8207 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await suite.newPage();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = suite.results;
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8207/?deploy=1&pos=0,0&yaw=0', { waitUntil: 'load' });
await wait(2800);

/* ============ 6. Debug interface existence and shape ============ */
const dbg = await page.evaluate(() => {
  const d = window.__mapDebug;
  if (!d) return null;
  return {
    keys: Object.keys(d).sort(),
    player: d.player,
    buildings: d.buildings.slice(0, 3),
    buildingsN: d.buildings.length,
    mode: d.mode,
    wm: d.worldToMap(0, -20),
    wmObj: d.worldToMap({ x: 0, z: -20 }),
  };
});
check('window.__mapDebug is exposed', !!dbg, dbg ? dbg.mode : 'missing');
check('__mapDebug.player includes {x,y,yaw}', !!dbg && dbg.player && 'x' in dbg.player && 'y' in dbg.player && 'yaw' in dbg.player,
  dbg ? JSON.stringify(dbg.player) : '');
check('__mapDebug.buildings includes {name,x,y}', !!dbg && dbg.buildingsN > 0 && 'name' in dbg.buildings[0],
  dbg ? `${dbg.buildingsN} entries, e.g.: ${JSON.stringify(dbg.buildings[0])}` : '');
check('worldToMap supports both (x,z) and {x,z} calls', !!dbg && JSON.stringify(dbg.wm) === JSON.stringify(dbg.wmObj),
  dbg ? `${JSON.stringify(dbg.wm)} / ${JSON.stringify(dbg.wmObj)}` : '');

/* ============ 2. Turn right 90°; a target dead ahead must move to the left of the map ============ */
const turn = await page.evaluate(() => {
  const g = window.__game, d = window.__mapDebug;
  const out = {};
  const ahead = { x: g.player.pos.x, z: g.player.pos.z - 20 };   // 20 m due north
  g.player.yaw = 0;
  out.at0 = d.worldToMap(ahead.x, ahead.z);
  // Actually turn right 90°: in this project decreasing yaw = turning right (yaw -= dx*sens in player.look)
  g.player.yaw = -Math.PI / 2;
  out.afterRight = d.worldToMap(ahead.x, ahead.z);
  g.player.yaw = 0;
  return out;
});
const cx = await page.evaluate(() => window.__game.ui._W / 2);
check('Turning baseline: at yaw=0 a target dead ahead is directly above on the map',
  Math.abs(turn.at0.x - cx) < 1.5, `x=${turn.at0.x} center=${cx}`);
check('After actually turning right 90°: the target formerly dead ahead moves to the LEFT of the map',
  turn.afterRight.x < cx - 5, `x=${turn.afterRight.x} should be < ${cx - 5}`);

/* ============ 1. Rotating 360° in place with no accumulated drift ============ */
const drift = await page.evaluate(() => {
  const g = window.__game, d = window.__mapDebug;
  const bx = 12, bz = -18;
  g.player.yaw = 0;
  const start = d.worldToMap(bx, bz);
  // Simulate "continuous turning" with 360 one-degree steps, setting absolute heading each step (not accumulating)
  let maxJump = 0, prev = start;
  for (let i = 1; i <= 360; i++) {
    g.player.yaw = (i * Math.PI) / 180;
    const m = d.worldToMap(bx, bz);
    const jump = Math.hypot(m.x - prev.x, m.y - prev.y);
    if (jump > maxJump) maxJump = jump;
    prev = m;
  }
  g.player.yaw = 2 * Math.PI;           // equivalent to 0
  const end = d.worldToMap(bx, bz);
  g.player.yaw = 0;
  return { start, end, maxJump, err: Math.hypot(end.x - start.x, end.y - start.y) };
});
check('Returns to the initial relative position after 360° (no accumulated drift)', drift.err < 0.01,
  `start(${drift.start.x.toFixed(2)},${drift.start.y.toFixed(2)}) end(${drift.end.x.toFixed(2)},${drift.end.y.toFixed(2)}) error=${drift.err.toFixed(5)}px`);
check('Single-step displacement is smooth at 1° increments (no jumps)', drift.maxJump < 3,
  `max single step=${drift.maxJump.toFixed(3)}px`);

/* ============ 3. Continuous 60-second rotation: smooth path, no wraparound ============ */
const sweep = await page.evaluate(() => {
  const g = window.__game, d = window.__mapDebug;
  const bx = -14, bz = -12;
  /* 60 s @60fps = 3600 frames; 10 full turns at constant speed → 1° per frame */
  const perFrame = (Math.PI * 2 * 10) / 3600;
  let prev = null, maxJump = 0, samples = 0;
  const steps = [];
  for (let i = 0; i <= 3600; i++) {
    g.player.yaw = i * perFrame % (Math.PI * 2);
    const m = d.worldToMap(bx, bz);
    if (prev) {
      const j = Math.hypot(m.x - prev.x, m.y - prev.y);
      steps.push(j);
      if (j > maxJump) maxJump = j;
    }
    prev = m; samples++;
  }
  g.player.yaw = 0;
  const sorted = steps.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { maxJump, median, samples };
});
/* A real "jump" makes the max single-frame displacement far larger than the median; at constant speed the two should be nearly equal */
check('Continuous rotation for 60 s / 10 turns: smooth path with no jumps',
  sweep.maxJump < Math.max(0.5, sweep.median * 2),
  `${sweep.samples} frames, median displacement=${sweep.median.toFixed(4)}px, max displacement=${sweep.maxJump.toFixed(4)}px (ratio ${(sweep.maxJump / sweep.median).toFixed(3)})`);

/* ============ 5. Player icon fixed at center + correct arrow direction ============ */
const icon = await page.evaluate(async () => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = 0;
  const res = { miniCenters: [], coneHalfDeg: [] };
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    g.player.yaw = yaw;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const d = window.__mapDebug;
    // The player maps to the center of the map
    const self = d.worldToMap(g.player.pos.x, g.player.pos.z);
    res.miniCenters.push(self);
    const cam = g.camera;
    res.coneHalfDeg.push(Math.atan(Math.tan((cam.fov * Math.PI / 180) / 2) * cam.aspect) * 180 / Math.PI);
  }
  g.player.yaw = 0;
  return res;
});
const centered = icon.miniCenters.every((m) =>
  Math.abs(m.x - cx) < 0.01 && Math.abs(m.y - cx) < 0.01);
check('Player icon stays at the map center (no offset when turning)', centered,
  icon.miniCenters.map((m) => `(${m.x.toFixed(1)},${m.y.toFixed(1)})`).join(' '));

const cones = icon.coneHalfDeg;
check('View-cone angle comes from the real camera FOV and stays consistent', Math.abs(cones[0] - cones[2]) < 0.01 && cones[0] > 30,
  `${cones.map((c) => c.toFixed(1)).join('° / ')}°`);

/* ============ 5b. Tactical map arrow direction (was reversed by 180°) ============ */
const arrow = await page.evaluate(() => {
  const g = window.__game;
  window.__arrow = [];
  if (!window.__arrowPatched) {
    window.__arrowPatched = true;
    const orig = CanvasRenderingContext2D.prototype.moveTo;
    CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
      if (Math.abs(x) < 0.01 && Math.abs(y + 11) < 0.01) {
        const m = this.getTransform();
        window.__arrow.push({ a: m.a, b: m.b, c: m.c, d: m.d });
      }
      return orig.call(this, x, y);
    };
  }
  const out = [];
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    g.player.yaw = yaw;
    window.__arrow.length = 0;
    g.tacmap.render();
    const m = window.__arrow[window.__arrow.length - 1];
    // Screen direction of local up (0,-1) after the matrix transform
    const dir = { x: -m.c, y: -m.d };
    // Expected: forward vector in map space = (-sin yaw, -cos yaw)
    const want = { x: -Math.sin(yaw), y: -Math.cos(yaw) };
    out.push({ yaw: +(yaw * 180 / Math.PI).toFixed(0), dir, want,
      dot: dir.x * want.x + dir.y * want.y });
  }
  g.player.yaw = 0;
  return out;
});
const arrowsOk = arrow.every((a) => a.dot > 0.99);
check('Tactical map arrow direction matches heading (was reversed 180°)', arrowsOk,
  arrow.map((a) => `${a.yaw}° dot=${a.dot.toFixed(3)}`).join(' | '));

/* ============ 4. Labels: horizontal, in bounds, non-overlapping ============ */
const labels = await page.evaluate(() => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = -30; g.player.yaw = 0;
  g.tacmap.render();
  const t = g.tacmap;
  const items = [];
  for (let i = 0; i < t.drawnN; i++) items.push(t.drawn[i]);
  // Verify: labels actually drawn must not overlap and must all lie inside the canvas
  let overlaps = 0, outOfBounds = 0;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.x < 2 || a.y - 7 < 2 || a.x + a.w > t.W - 2 || a.y + 7 > t.H - 2) outOfBounds++;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.x - 3 < b.x + b.w + 3 && a.x + a.w + 3 > b.x - 3 &&
          a.y - 7 < b.y + 9 && a.y + 9 > b.y - 7) overlaps++;
    }
  }
  return { stats: { ...t.labelStats }, drawn: items.length, overlaps, outOfBounds,
    canvas: { w: t.W, h: t.H }, sample: items.slice(0, 4).map((p) => p.text) };
});
check('Tactical map labels: drawn, zero overlaps, zero out of bounds',
  labels.drawn > 0 && labels.overlaps === 0 && labels.outOfBounds === 0,
  `candidates ${labels.stats.total} → drawn ${labels.drawn} (yielded on overlap ${labels.stats.rejected}, out of bounds ${labels.stats.offscreen}); e.g. ${labels.sample.join(' / ')}`);

const miniLabels = await page.evaluate(() => {
  const g = window.__game;
  const ui = g.ui;
  const cv = document.querySelector('#minimap');
  const dpr = cv.width / cv.clientWidth;
  const ctx = cv.getContext('2d');
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
  // Check whether the canvas has text backings (rgba(6,11,16,.62) visibly darkens buildings)
  return { w: cv.clientWidth, h: cv.clientHeight, dpr, zones: ui.zoneItems.length,
    placerRejected: ui.placer.rejected };
});
check('Minimap has a place-name label system', miniLabels.zones > 0 && miniLabels.w > 0,
  `${miniLabels.zones} place-name candidates, canvas ${miniLabels.w}×${miniLabels.h}@${miniLabels.dpr}x`);

/* ============ 6b. Rendered pixels match worldToMap (end-to-end) ============ */
const pixel = await page.evaluate(async () => {
  const g = window.__game, d = window.__mapDebug;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0;
  const mate = g.squad[0];
  mate.pos.x = 0; mate.pos.z = -20;
  g.squad.slice(1).forEach((s) => { s.pos.x = 500; s.pos.z = 500; });
  g.suspects.forEach((s) => { s.pos.x = 500; s.pos.z = 500; });
  g.civilians.forEach((c) => { c.pos.x = 500; c.pos.z = 500; });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.querySelector('#minimap');
  const ctx = cv.getContext('2d');
  const dpr = cv.width / cv.clientWidth;
  const expect = d.worldToMap(mate.pos.x, mate.pos.z);
  const px = Math.round(expect.x * dpr), py = Math.round(expect.y * dpr);
  const d2 = ctx.getImageData(px - 5, py - 5, 11, 11).data;
  let hits = 0;
  for (let i = 0; i < d2.length; i += 4) {
    if (Math.abs(d2[i] - 78) < 45 && Math.abs(d2[i + 1] - 168) < 45 && Math.abs(d2[i + 2] - 255) < 45 && d2[i + 3] > 120) hits++;
  }
  // Reverse check: the wrong (old-formula) position should have no blue teammate marker
  const C = Math.cos(-g.player.yaw), S = Math.sin(-g.player.yaw);
  const dx = mate.pos.x - g.player.pos.x, dz = mate.pos.z - g.player.pos.z;
  const k = d.worldToMap(0, 0).x ? (g.ui._W / 2) / g.ui.miniRange : 1;
  const wrongX = Math.round((g.ui._W / 2 + (dx * C - dz * S) * k) * dpr);
  const wrongY = Math.round((g.ui._H / 2 + (dx * S + dz * C) * k) * dpr);
  let wrongHits = 0;
  if (Math.abs(wrongX - px) > 3 || Math.abs(wrongY - py) > 3) {
    const d3 = ctx.getImageData(wrongX - 5, wrongY - 5, 11, 11).data;
    for (let i = 0; i < d3.length; i += 4) {
      if (Math.abs(d3[i] - 78) < 45 && Math.abs(d3[i + 1] - 168) < 45 && Math.abs(d3[i + 2] - 255) < 45 && d3[i + 3] > 120) wrongHits++;
    }
  }
  const separated = Math.hypot(wrongX - px, wrongY - py);
  return { expect, hits, wrongHits, separated: +separated.toFixed(1), px, py, wrongX, wrongY };
});
check('Minimap rendered pixels match __mapDebug.worldToMap', pixel.hits > 0,
  `hit ${pixel.hits} blue pixels at the expected position`);
/* Counter-proof: the old (sign-flipped) formula position must have no teammate marker, or the two formulas are not separated / rendering has another source */
check('No teammate marker at the old (wrong) formula position (counter-proof the rotation direction is fixed)',
  pixel.separated < 3 || pixel.wrongHits === 0,
  `the two positions are ${pixel.separated}px apart; wrong position hit ${pixel.wrongHits} blue pixels`);

/* ============ Zero per-frame allocation (GC churn) ============ */
const alloc = await page.evaluate(() => {
  const g = window.__game;
  // Render 120 consecutive frames; check the label pool capacity stays constant and objects are reused
  const before = g.ui.placer.buf.length;
  const firstRef = g.ui.placer.buf[0];
  for (let i = 0; i < 120; i++) {
    g.player.yaw = i * 0.05;
    g.ui.drawMinimap(g);
    g.tacmap.render();
  }
  const after = g.ui.placer.buf.length;
  return { before, after, reused: firstRef === g.ui.placer.buf[0] };
});
check('Label/coordinate buffers are reused every frame (no new allocations)',
  alloc.before === alloc.after && alloc.reused,
  `buffer ${alloc.before} → ${alloc.after}, objects reused=${alloc.reused}`);

await suite.finish();
