/* ============================================================
   tools/p1-test.mjs — reproduction and regression of P1 defects
   ------------------------------------------------------------
   P1-1 fireCd / blind decremented twice, by updateCommon and Player.update
        (double fire rate + flashbang blind time halved)
   P1-2 moveDir computed speed from the change in the coordinate sum ⇒ diagonal vel always 0
   P1-3 unreachable AI cover: a full A* every frame, and a return that skipped firing ⇒ stands and never shoots
   P1-4 per-frame fixed-ratio interpolation (FOV / muzzle light / head recovery) varied with refresh rate
   P1-5 mission timers not cancelled on abort()/redeploy, polluting the next mission
   P1-6 identification kept advancing at full speed in the pause menu / tactical map
   P1-7 report() dead branch (squad could never spot first); burst logic masked by the fireCd branch
   Usage: node tools/p1-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('p1-test');
const server = await suite.serve({ port: 8216 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await suite.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8216/?deploy=1&test=1', { waitUntil: 'load' });
await wait(2600);
await page.evaluate(() => { window.__game.testMode = true; });

/* ============================================================
   P1-1 fire rate and blind duration
   ============================================================ */
const t1 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  p.active = 'primary';
  p.fireCd = 0; p.reloading = 0; p.blind = 0;
  p.mag.primary = 5000; p.reserve.primary = 5000;
  g.input.keys.clear();
  const before = g.stats.shots;
  g.input.lmb = true;
  for (let i = 0; i < 90; i++) g.advance(1 / 60, 1 / 60);   // 1.5 s at a fixed step
  g.input.lmb = false;

  /* blind duration: blind=4, advance exactly 1 s */
  p.blind = 4;
  const blindBefore = p.blind;
  for (let i = 0; i < 60; i++) g.advance(1 / 60, 1 / 60);
  return {
    shots: g.stats.shots - before,
    blindBefore,
    blindAfter: +p.blind.toFixed(3),
    rpm: p.primaryDef.rpm,
  };
});
/* Rated 640 rpm ⇒ 16 rounds in 1.5 s; 15 after per-frame quantisation.
   The double decrement gave 30, so a ceiling of 18 pins the bug. */
check('P1-1 fire rate no longer doubled (90 frames @640rpm ≈15 rounds, not 30)',
  t1.shots <= 18 && t1.shots >= 13,
  'rated ' + t1.rpm + 'rpm, measured ' + t1.shots + ' rounds in 1.5 s (30 before the fix)');
check('P1-1 flashbang blind time no longer halved (blind 4 → 3 left after 1 s, not 2)',
  t1.blindAfter > 2.5,
  'blind ' + t1.blindBefore + ' → ' + t1.blindAfter + ' (~2.0 before the fix)');

/* ============================================================
   P1-2 speed reading for diagonal movement
   ============================================================ */
const t2 = await page.evaluate(() => {
  const g = window.__game;
  const a = g.player;
  const sp = g.world.spawns.player;
  g.input.lmb = false;
  g.input.keys.clear();
  /* call moveDir diagonally: fx=+1, fz=-1. Before the fix vel was always 0. */
  a.pos.x = sp.x; a.pos.z = sp.z;
  a.moveDir(1, -1, 3.1, 1 / 60);
  const diagVel = +a.vel.toFixed(3);
  /* then run real input (W+D) to confirm the whole chain works */
  a.pos.x = sp.x; a.pos.z = sp.z; a.yaw = sp.yaw; a.pitch = 0;
  g.input.keys.add('KeyW'); g.input.keys.add('KeyD');
  let maxVel = 0;
  for (let i = 0; i < 30; i++) { g.advance(1 / 60, 1 / 60); maxVel = Math.max(maxVel, a.vel); }
  g.input.keys.clear();
  return { diagVel, maxVel: +maxVel.toFixed(3) };
});
check('P1-2 diagonal moveDir speed reading is no longer 0', t2.diagVel > 0.5,
  'moveDir(1,-1,3.1) ⇒ vel=' + t2.diagVel + ' m/s (0 before the fix)');
check('P1-2 real W+D diagonal speed reading is normal', t2.maxVel > 0.5,
  'peak vel=' + t2.maxVel + ' m/s (≈0 before the fix)');

/* ============================================================
   P1-3 unreachable cover: no full A* every frame, and must still fire
   ============================================================ */
const t3 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  const s = g.suspects.find((x) => x.alive);
  s.pos.x = p.pos.x; s.pos.z = p.pos.z - 8;
  s.hp = s.maxHp; s.morale = 1; s.blind = 0;
  s.state = 'engage'; s.alerted = true; s.awareness = 1;
  s.target = p; s.seenTarget = p;
  /* deliberately give cover that isn't on the nav grid, and push the re-search timer far out */
  s.coverPos = { x: 9999, z: 9999 };
  s.coverTimer = 99;
  s.fireCd = 0; s.path = null; s.pathAge = 0; s.burstLeft = 4;

  let setPathCalls = 0;
  s.setPath = function () { setPathCalls++; return null; };   // force failure
  let shots = 0;
  const origShoot = s.shootAt.bind(s);
  s.shootAt = function (...args) { shots++; return origShoot(...args); };

  for (let i = 0; i < 120; i++) {                              // 2 s
    s.target = p; s.seenTarget = p; s.awareness = 1; s.state = 'engage';
    s.pos.x = p.pos.x; s.pos.z = p.pos.z - 8;                  // pinned in a visible spot
    s.update(1 / 60);
  }
  return { setPathCalls, shots, coverPos: s.coverPos };
});
check('P1-3 unreachable cover no longer triggers a full A* every frame',
  t3.setPathCalls <= 10,
  'setPath called ' + t3.setPathCalls + ' times in 120 frames (120 before the fix)');
check('P1-3 a suspect with unreachable cover still fires (no longer skipped by return)',
  t3.shots > 0,
  'fired ' + t3.shots + ' times in 120 frames (0 before the fix)');

/* ============================================================
   P1-4 frame-rate independence: the same time span should give the same result at 60 fps and 144 fps
   ============================================================ */
const t4 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  const cam = g.camera;
  const SPAN = 0.1;   // a short span, otherwise both fully converge and the difference disappears

  /* Key point: both frame rates must cover exactly the same simulated time.
     Rounding n = round(SPAN*fps) gives 144 fps 14 steps × 1/144 = 0.0972 s,
     2.8% shorter than 60 fps's 0.1 s, so exponential decay differs slightly — a test bug, not a code bug.
     Here the step count is fixed and dt spread as SPAN/n, so total time is exactly equal. */
  const stepsFor = (fps) => Math.max(1, Math.round(SPAN * fps));

  const runFov = (fps) => {
    cam.fov = 72;
    const dt = SPAN / stepsFor(fps);
    for (let i = 0; i < stepsFor(fps); i++) {
      p.stance = 'sprint'; p.ads = 0; p.moving = 0;
      p.applyCamera(cam, dt);
    }
    return cam.fov;
  };
  const fov60 = runFov(60), fov144 = runFov(144);

  const runMuzzle = (fps, span) => {
    const fx = g.effects;
    fx.muzzleLight.intensity = 100;
    fx.muzzleTimer = 999;                 // sidestep the timer reset, look only at decay
    const n = Math.max(1, Math.round(span * fps));
    const dt = span / n;
    for (let i = 0; i < n; i++) fx.update(dt);
    const v = fx.muzzleLight.intensity;
    fx.muzzleTimer = 0; fx.muzzleLight.intensity = 0;
    return v;
  };
  const mz60 = runMuzzle(60, 0.1), mz144 = runMuzzle(144, 0.1);

  const runHead = (fps) => {
    const m = g.squad.find((x) => x.alive) || g.squad[0];
    const SPAN_H = 0.5;
    const n = Math.max(1, Math.round(SPAN_H * fps));
    const dt = SPAN_H / n;
    m.parts.head.rotation.x = 0.3; m.parts.head.rotation.z = 0.3;
    for (let i = 0; i < n; i++) { m.blind = 0; m.animate(dt); }
    return m.parts.head.rotation.x;
  };
  const h60 = runHead(60), h144 = runHead(144);

  return {
    fov60: +fov60.toFixed(4), fov144: +fov144.toFixed(4),
    mz60: +mz60.toFixed(4), mz144: +mz144.toFixed(4),
    h60: +h60.toFixed(5), h144: +h144.toFixed(5),
  };
});
check('P1-4 camera FOV transition is refresh-rate independent',
  Math.abs(t4.fov60 - t4.fov144) < 0.05,
  'after 0.1 s 60fps=' + t4.fov60 + ' / 144fps=' + t4.fov144 +
  ' (with per-frame fixed ratio: 60fps=75.21 / 144fps=77.00)');
check('P1-4 muzzle flash decay is refresh-rate independent',
  Math.abs(t4.mz60 - t4.mz144) < Math.max(0.05, t4.mz60 * 0.05),
  'after 0.1 s 60fps=' + t4.mz60 + ' / 144fps=' + t4.mz144);
check('P1-4 head recovery is refresh-rate independent',
  Math.abs(t4.h60 - t4.h144) < 0.005,
  'after 0.5 s 60fps=' + t4.h60 + ' / 144fps=' + t4.h144);

/* ============================================================
   P1-5 mission timers must be cancelled on abort()/redeploy
   ------------------------------------------------------------
   Note: the "control + split" structure here is deliberate, for two reasons —
     1) control: first prove a bare 3.2 s setTimeout really fires in this headless environment.
        Otherwise "the new mission wasn't ended" could just mean the timer never ran — a false green.
     2) split: "cause a death" and "abort and redeploy" run in two separate evaluates.
        Crammed into one synchronous block, the old version's delayed callback never takes effect
        and this assertion falsely passes on the buggy code (verified).
   ============================================================ */
const t5a = await page.evaluate(() => {
  const g = window.__game;
  g.deploy(g.loadout);
  g.testMode = true;
  g.raiseAlarm('test');
  return { tracked: g._timers ? g._timers.size : -1 };
});
check('P1-5 mission timers are registered (raiseAlarm schedules at least one)', t5a.tracked > 0,
  '_timers.size=' + t5a.tracked + ' (no such mechanism before the fix)');

const t5b = await page.evaluate(() => {
  const g = window.__game;
  /* kill the team lead: this schedules finishMission(false) 3.2 s later */
  g.player.takeDamage(9999, null);
  return { pending: g._timers.size, failed: g.failed, state: g.state };
});
check('P1-5 a delayed debrief callback really is queued after death', t5b.pending > 0,
  '_timers.size=' + t5b.pending);

await page.evaluate(() => {
  const g = window.__game;
  g.abort();
  g.deploy(g.loadout);
  g.testMode = false;                 // wait on the real main loop and see whether the old callback fires
});
/* the control sits inside the waiting window: proves page setTimeouts really run during this period */
await page.evaluate(() => {
  window.__p5control = 0;
  setTimeout(() => { window.__p5control++; }, 1000);
});
await wait(4200);                     // past 3.2 s, the old callback would have fired by now
const t5c = await page.evaluate(() => {
  const g = window.__game;
  const debriefShown = !document.getElementById('screen-debrief').classList.contains('hidden');
  return { state: g.state, timers: g._timers.size, control: window.__p5control, debriefShown };
});
check('P1-5 control: a 1 s timer really fires in this environment (guards against false green)',
  t5c.control === 1,
  'control timer fired ' + t5c.control + ' times (must be 1)');
/* watch state, not failed:
   deploy() resets failed, and the old callback goes through finishMission(false),
   which doesn't touch failed — it sets the new mission's state to 'debrief' and pops the debrief screen. */
check('P1-5 after abort and redeploy, the previous mission\'s debrief callback must not end the new one',
  t5c.state === 'play' && t5c.debriefShown === false,
  'after 4.2 s new mission state=' + t5c.state + ', debrief visible=' + t5c.debriefShown +
  ' (before the fix the old callback pushed it straight to debrief)');
check('P1-5 timer set cleared after redeploy', t5c.timers === 0, '_timers.size=' + t5c.timers);

/* ============================================================
   P1-6 identification must freeze in the pause menu / tactical map
   ============================================================ */
const t6 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  g.testMode = true;
  const s = g.suspects.find((x) => x.alive);
  s.ident = 0; s.identified = false; s.seen = false;
  p.pos.x = 0; p.pos.z = 0; p.yaw = 0; p.pitch = 0; p.ads = 0;
  s.pos.x = 0; s.pos.z = -8; s.y = 0;
  g.suspects.forEach((o) => { if (o !== s) { o.pos.x = 900; o.pos.z = 900; } });

  const step = (n, opts) => {
    g.paused = !!opts.paused;
    if (opts.tacmap) { if (!g.tacmap.open) g.toggleTacMap(); }
    else if (g.tacmap.open) g.toggleTacMap();
    for (let i = 0; i < n; i++) g.advance(1 / 60, 1 / 60);
  };

  /* normal play: should grow */
  s.ident = 0;
  step(30, {});
  const normal = +s.ident.toFixed(4);

  /* pause menu: must freeze. Push ident back down first,
     otherwise once it hits the 1.0 cap "didn't grow" and "grew but clamped" are indistinguishable. */
  s.ident = 0.3;
  const beforePause = s.ident;
  step(60, { paused: true });
  const afterPause = +s.ident.toFixed(4);

  /* tactical map open: must freeze (also pushed back down first) */
  g.paused = false;
  s.ident = 0.3;
  if (!g.tacmap.open) g.toggleTacMap();
  const beforeMap = s.ident;
  for (let i = 0; i < 60; i++) g.advance(1 / 60, 1 / 60);
  const afterMap = +s.ident.toFixed(4);

  if (g.tacmap.open) g.toggleTacMap();
  g.paused = false;
  return { normal, beforePause: +beforePause.toFixed(4), afterPause, beforeMap: +beforeMap.toFixed(4), afterMap };
});
check('P1-6 identification advances in normal play (precondition)', t6.normal > 0.05,
  'ident after 30 frames=' + t6.normal);
check('P1-6 identification no longer advances in the pause menu',
  Math.abs(t6.afterPause - t6.beforePause) < 1e-6,
  'ident ' + t6.beforePause + ' → ' + t6.afterPause + ' (kept growing before the fix)');
check('P1-6 identification no longer advances with the tactical map open',
  Math.abs(t6.afterMap - t6.beforeMap) < 1e-6,
  'ident ' + t6.beforeMap + ' → ' + t6.afterMap);

/* ============================================================
   P1-7 squad spots first + burst rhythm
   ============================================================ */
const t7a = await page.evaluate(() => {
  const g = window.__game;
  const m = g.squad.find((x) => x.alive);
  const s = g.suspects.find((x) => x.alive);
  s.seen = false; s.identified = false; s.ident = 0;
  s.pos.x = m.pos.x + 6; s.pos.z = m.pos.z;
  m.reportCd = 0;
  /* call report() directly: before the fix `if (!target.seen) return;` made this branch unreachable */
  let threw = null;
  try { m.report(s); } catch (e) { threw = String(e && e.message ? e.message : e); }
  return { seen: s.seen, reportCd: m.reportCd, threw };
});
check('P1-7 report() can mark "squad spotted first" (unidentified contact)',
  t7a.seen === true && t7a.threw === null,
  'target.seen=' + t7a.seen + (t7a.threw ? ' threw: ' + t7a.threw : '') + ' (always false before the fix)');

const t7b = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  /* isolate: only this suspect + the player, squad fire off; otherwise the squad kills/talks down the target,
     and the interrupted engagement pollutes the burst-rhythm measurement. */
  g.weaponsFree = false;
  g.squad.forEach((m) => { m.pos.x = 900; m.pos.z = 900; });
  g.suspects.forEach((o, i) => { if (o !== g.suspects[0]) { o.pos.x = 900; o.pos.z = 900 + i; } });
  const s = g.suspects.find((x) => x.alive);
  s.hp = s.maxHp; s.morale = 1; s.blind = 0;
  s.state = 'engage'; s.alerted = true; s.awareness = 1;
  s.fireCd = 0; s.burstLeft = 4; s.burstGap = 0.8;
  /* player pinned 8 m away and invulnerable: otherwise the target's death ends the engagement */
  p.pos.x = 0; p.pos.z = 0;
  s.pos.x = 0; s.pos.z = -8;

  const times = [];
  const origShoot = s.shootAt.bind(s);
  let recording = false;
  let frame = 0;
  s.shootAt = function (...args) { if (recording) times.push(frame); return origShoot(...args); };

  const tick = () => {
    s.target = p; s.seenTarget = p; s.awareness = 1; s.state = 'engage';
    s.surrendered = false; s.detained = false;
    s.hp = s.maxHp; s.morale = 1; s.blind = 0;
    p.hp = p.maxHp; p.alive = true;
    s.pos.x = 0; s.pos.z = -8;
    s.update(1 / 60);
  };

  for (let i = 0; i < 60; i++, frame++) tick();      // 1 s warm-up, discards the opening half-burst
  recording = true;
  for (let i = 0; i < 60 * 10; i++, frame++) tick(); // record 10 s

  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 60);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const burstSizes = [];
  let run = 1;
  for (const gp of gaps) {
    if (gp < 0.3) run++; else { burstSizes.push(run); run = 1; }
  }
  if (burstSizes.length) burstSizes.push(run);       // also count the unfinished final burst
  return { shots: times.length, maxGap: +maxGap.toFixed(3), burstSizes };
});
check('P1-7 there are pauses between bursts (the old version was a constant 0.11 s metronome)',
  t7b.maxGap > 0.4,
  t7b.shots + ' rounds in 10 s, longest gap ' + t7b.maxGap + 's (constant ~0.11 s before the fix)');
/* warm-up already dropped the opening half-burst; the final burst may be cut by the window, so one exception is allowed */
const inRange = t7b.burstSizes.filter((n) => n >= 3 && n <= 5).length;
check('P1-7 burst length within the designed 3–5 rounds',
  t7b.burstSizes.length >= 3 && inRange >= t7b.burstSizes.length - 1,
  t7b.burstSizes.length + ' bursts, rounds per burst=' + JSON.stringify(t7b.burstSizes.slice(0, 10)));

await suite.finish();
