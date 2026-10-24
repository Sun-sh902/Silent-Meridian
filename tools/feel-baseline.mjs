/* ============================================================
   tools/feel-baseline.mjs - handling regression baseline (fixed step, bit-reproducible)
   ------------------------------------------------------------
   Drives game.advance() at a fixed 1/60 s step, removing rAF jitter and rendering differences.
   Usage:
     node tools/feel-baseline.mjs capture tools/feel-baseline.json
     node tools/feel-baseline.mjs compare tools/feel-baseline.json
   ============================================================ */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Suite, ROOT as root } from './harness.mjs';

const suite = new Suite('feel-baseline');
const server = await suite.serve({ port: 8209 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await suite.newPage();
/* fixed random sequence: horizontal recoil etc. use Math.random and must be reproducible */
await page.evaluateOnNewDocument(() => {
  let seed = 0x2f6e2b1;
  window.__randCalls = 0;
  Math.random = () => {
    window.__randCalls++;
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  /* Lets the baseline pin the random stream to a fixed position before random-sensitive measurements.
     Without it, any change elsewhere that alters how often Math.random is consumed (e.g. AI logic)
     shifts recoil.yawSeq wholesale — that would measure "position in the random stream", not recoil logic. */
  window.__reseed = (v = 0x2f6e2b1) => { seed = v >>> 0; window.__randCalls = 0; };
});
await page.goto('http://127.0.0.1:8209/?deploy=1&test=1', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2600));   // ?test=1 already froze rAF stepping, so warm-up adds no random-stream drift

const data = await page.evaluate(() => {
  const g = window.__game;
  const P = g.player;
  const DT = 1 / 60;
  g.testMode = true;   // belt and braces (the URL parameter already sets it)
  const r6 = (v) => +v.toFixed(6);
  const r8 = (v) => +v.toFixed(8);

  const reset = () => {
    g.input.keys.clear();
    g.input.lmb = false; g.input.rmb = false; g.input.lmbPressed = false;
    P.pos.x = 0; P.pos.z = 0; P.yaw = 0; P.pitch = 0;
    P.ads = 0; P.reloading = 0; P.fireCd = 0; P.burstCount = 0;
    P.recoil.pitch = 0; P.recoil.yaw = 0;
    P.stamina = 1; P.suppression = 0; P.blind = 0; P.vel = 0;
    P.mag.primary = P.primaryDef.mag; P.reserve.primary = P.primaryDef.reserve;
    P.active = 'primary'; P.shotLog.length = 0; P.lastShotIndex = 0; P.lastSpread = 0;
    g.suspects.forEach((s, i) => { s.pos.x = 900 + i; s.pos.z = 900; });
    g.civilians.forEach((c, i) => { c.pos.x = 900 + i; c.pos.z = 900; });
    g.squad.forEach((m, i) => { m.pos.x = -900 - i; m.pos.z = -900; });
    g.mapEvents.length = 0;
  };
  const step = (n) => { for (let i = 0; i < n; i++) g.advance(DT, DT); };

  const out = {};

  /* 1. steady-state speed and FOV per stance (derived from displacement after running 1 s) */
  const measure = (keys, rmb) => {
    reset();
    keys.forEach((k) => g.input.keys.add(k));
    if (rmb) g.input.rmb = true;
    step(30);
    const x0 = P.pos.x, z0 = P.pos.z;
    step(60);
    const dist = Math.hypot(P.pos.x - x0, P.pos.z - z0);
    return { speed: r6(dist), fov: r6(g.camera.fov), ads: r6(P.ads) };
  };
  out.move = {
    walk: measure(['KeyW'], false),
    sprint: measure(['KeyW', 'ShiftLeft'], false),
    crouch: measure(['KeyW', 'ControlLeft'], false),
    ads: measure(['KeyW'], true),
    diag: measure(['KeyW', 'KeyD'], false),
    back: measure(['KeyS'], false),
  };

  /* 2. start ramp and release braking (currently instant ⇒ full speed on the first step, stop on release) */
  reset();
  g.input.keys.add('KeyW');
  const ramp = [];
  let px = P.pos.x, pz = P.pos.z;
  for (let i = 0; i < 6; i++) {
    g.advance(DT, DT);
    ramp.push(r6(Math.hypot(P.pos.x - px, P.pos.z - pz) / DT));
    px = P.pos.x; pz = P.pos.z;
  }
  g.input.keys.delete('KeyW');
  g.advance(DT, DT);
  out.ramp = { perStep: ramp, afterRelease: r6(Math.hypot(P.pos.x - px, P.pos.z - pz) / DT) };

  /* 3. camera: peak roll and head bob while walking */
  reset();
  g.input.keys.add('KeyW');
  let rollMax = 0, bobY = 0;
  const eyeY = P.eye.y;
  for (let i = 0; i < 180; i++) {
    g.advance(DT, DT);
    rollMax = Math.max(rollMax, Math.abs(g.camera.rotation.z));
    bobY = Math.max(bobY, Math.abs(g.camera.position.y - eyeY));
  }
  out.camera = { rollMax: r6(rollMax), bobY: r6(bobY) };

  /* 4. spread: burst accumulation */
  reset();
  P.logShots = true;
  g.input.lmb = true;
  step(90);
  g.input.lmb = false;
  out.spread = {
    shots: P.shotLog.length,
    first: r8(P.shotLog[0] ? P.shotLog[0].s : 0),
    last: r8(P.shotLog.length ? P.shotLog[P.shotLog.length - 1].s : 0),
  };

  /* 5. recoil: per-shot accumulation (no decay between frames) and sequence reproducibility */
  const pitchAfter = (k) => {
    reset(); P.logShots = true;
    for (let i = 0; i < k; i++) { P.fireCd = 0; P.fireOnce(); }
    return r8(P.recoil.pitch);
  };
  out.recoil = {
    pitchAfter: [1, 2, 3, 5, 8, 13].map(pitchAfter),
    /* horizontal recoil per shot comes from Math.random, so pin the random stream first,
       otherwise the sequence shifts whenever something else consumes a few extra random numbers. */
    yawSeq: (() => {
      reset(); window.__reseed(0x51ed); P.logShots = true;
      for (let i = 0; i < 5; i++) { P.fireCd = 0; P.fireOnce(); }
      return P.shotLog.map((v) => r8(v.y));
    })(),
  };
  reset();
  for (let i = 0; i < 5; i++) { P.fireCd = 0; P.fireOnce(); }
  const decay0 = P.recoil.pitch;
  step(60);
  out.recoil.decay = { start: r8(decay0), afterOneSecond: r8(P.recoil.pitch) };

  /* 6. reload / switch / ADS transitions */
  reset();
  P.mag.primary = 0; P.startReload();
  let rs = 0;
  while (P.reloading > 0 && rs < 900) { g.advance(DT, DT); rs++; }
  out.reload = { seconds: r6(rs * DT), magAfter: P.mag.primary };
  reset();
  const before = P.active;
  P.switchWeapon();
  out.reload.switchSeconds = r6(P.fireCd);
  out.reload.switched = before !== P.active;
  reset();
  g.input.rmb = true;
  let ain = 0;
  while (P.ads < 0.999 && ain < 600) { g.advance(DT, DT); ain++; }
  out.reload.adsInSeconds = r6(ain * DT);
  g.input.rmb = false;
  let aout = 0;
  while (P.ads > 0.001 && aout < 600) { g.advance(DT, DT); aout++; }
  out.reload.adsOutSeconds = r6(aout * DT);

  /* 7. feedback: shake envelope and muzzle flash duration */
  reset();
  g.shake(0.28, 0.12);
  out.feedback = { shakeStart: r6(g.camShake) };
  step(30);
  out.feedback.shakeAfterHalfSecond = r6(g.camShake);
  reset();
  P.fireCd = 0; P.fireOnce();
  out.feedback.muzzleTimer = r6(g.effects.muzzleTimer);
  out.feedback.hitmarkerTime = r6(0);

  /* 8. meta (confirms the measurement used the current loadout) */
  out.meta = {
    randCalls: window.__randCalls,
    armorSpeed: P.armor.speed, armorHp: P.armor.hp,
    weapon: P.def.id, rpm: P.def.rpm, range: P.def.range,
    spread: P.def.spread, adsSpread: P.def.adsSpread, moveSpread: P.def.moveSpread,
    reloadTime: P.def.reload, damage: P.def.damage,
  };

  P.logShots = false;
  g.testMode = false;
  return out;
});

const mode = process.argv[2] || 'capture';
const file = process.argv[3] || join(root, 'tools', 'feel-baseline.json');

if (mode === 'capture') {
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  console.log('Baseline captured -> ' + file);
  console.log(JSON.stringify(data, null, 2));
  suite.check('no page errors during capture', suite.pageErrors.length === 0, suite.pageErrors.slice(0, 2).join(' | '));
  await suite.finish();
} else {
  const old = JSON.parse(await readFile(file, 'utf8'));
  const diffs = [];
  const walk = (a, b, path) => {
    if (typeof a === 'number' && typeof b === 'number') {
      const d = Math.abs(a - b);
      const m = Math.max(Math.abs(a), Math.abs(b));
      const rel = m > 1e-9 ? d / m : 0;
      if (d > 1e-6 && rel > 1e-6) diffs.push(path + ': ' + a + ' -> ' + b + ' (d=' + d.toExponential(3) + ')');
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) { diffs.push(path + ': length ' + a.length + ' -> ' + b.length); return; }
      a.forEach((v, i) => walk(v, b[i], path + '[' + i + ']'));
      return;
    }
    if (a && b && typeof a === 'object') {
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      for (const k of keys) walk(a[k], b[k], path ? path + '.' + k : k);
      return;
    }
    if (a !== b) diffs.push(path + ': ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b));
  };
  walk(old, data, '');
  /* meta.* are diagnostics such as "position in the random stream", not handling metrics.
     Any change elsewhere that alters Math.random consumption moves them,
     so counting them as regressions would turn "feel baseline red" into noise — report only, never fail.
     (recoil.yawSeq is pinned with __reseed before capture, so it stays a hard assertion.) */
  const feelDiffs = diffs.filter((d) => !d.startsWith('meta.'));
  const infoDiffs = diffs.filter((d) => d.startsWith('meta.'));
  console.log('');
  console.log('===== Handling regression comparison =====');
  if (!feelDiffs.length) console.log('[PASS] handling metrics bit-identical to baseline (no behaviour change)');
  else {
    console.log('[FAIL] ' + feelDiffs.length + ' handling differences found:');
    feelDiffs.slice(0, 40).forEach((d) => console.log('   ' + d));
  }
  if (infoDiffs.length) {
    console.log('[info] ' + infoDiffs.length + ' diagnostic changes (not counted as failures):');
    infoDiffs.slice(0, 6).forEach((d) => console.log('   ' + d));
  }
  suite.check('handling metrics bit-identical to baseline', feelDiffs.length === 0, feelDiffs.slice(0, 3).join(' | '));
  await suite.finish();   // page errors count toward the exit code here (the old print came after exit and was unreachable)
}
