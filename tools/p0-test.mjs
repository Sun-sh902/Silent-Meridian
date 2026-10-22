/* ============================================================
   tools/p0-test.mjs — reproduction and regression of P0 defects
   ------------------------------------------------------------
   P0-1 Move and clear: calls the undefined g.onElementArrived when a member arrives
   P0-2 SEMI/PUMP/REVOLVER cannot fire (lmbHeld is set too early)
   P0-3 D is swallowed by the debug panel in the capture phase; cannot strafe right in Alt cursor mode
   P0-4 paused is not reset after pause→abort→redeploy; the new run freezes
   P0-5 The pause menu does not change state, so checking state alone makes D a dead key (can't open the panel or strafe)
   P0-6 elementDone is only written, never read; after both teams arrive boundPhase flips forever for no reason
   Usage: node tools/p0-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('p0-test');
const server = await suite.serve({ port: 8215 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await suite.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8215/?deploy=1&test=1', { waitUntil: 'load' });
await wait(2600);
/* Fixed timestep throughout: prevents a real rAF frame from slipping in between "dispatch mousedown" and "manual advance"
   and consuming the press edge signal (this caused intermittent P0-2 failures). */
await page.evaluate(() => { window.__game.testMode = true; });

/* ---------------- P0-1 Move and clear: issue 3 times and wait for members to arrive ---------------- */
const t1 = await page.evaluate(() => {
  const g = window.__game;
  g.testMode = true;
  g.input.keys.clear();
  g.player.pos.x = 0; g.player.pos.z = 0;
  g.squad.forEach((m, i) => { m.pos.x = -2 + i * 1.5; m.pos.z = 2; m.path = null; m.pathAge = 0; });
  g.suspects.forEach((s, i) => { s.pos.x = 900; s.pos.z = 900 + i; });
  const orders = [];
  let err = null, steps = 0, stoppedAt = -1;
  try {
    for (let n = 0; n < 3; n++) {
      g.issueClearAt(0, -4 - n * 3);          // waypoints are close, guaranteeing arrival
      orders.push(g.squadOrder);
      for (let i = 0; i < 240; i++) {
        g.advance(1 / 60, 1 / 60);
        steps++;
      }
    }
  } catch (e) {
    err = String((e && e.message) || e);
    stoppedAt = steps;
  }
  g.squadOrder = 'hold';
  g.squadWaypoint = null;
  return { err, steps, orders, stoppedAt };
});
check('P0-1 Issue "move and clear" 3 times and advance until members arrive, with no exception',
  t1.err === null,
  t1.err ? ('threw at step ' + t1.stoppedAt + ': ' + t1.err) : ('advanced ' + t1.steps + ' steps with no exception'));
check('P0-1 Simulation was not interrupted by an exception (should advance 720 steps)', t1.steps === 720,
  'steps=' + t1.steps + ' (stopped at ' + t1.stoppedAt + ')');

/* ---------------- P0-2 Non-AUTO firing (through real mouse events) ---------------- */
/* Key point: the press-edge signal must be set by a real mousedown hitting the canvas handler;
   setting g.input.lmb directly bypasses the input chain and cannot catch P0-2-class defects. */
async function fireOnceReal(setup) {
  await page.evaluate((cfg) => {
    const g = window.__game;
    const P = g.player;
    if (cfg.sidearm) { P.active = 'sidearm'; }
    else { P.active = 'primary'; P.primaryDef = Object.assign({}, P.primaryDef, { mode: cfg.mode }); }
    P.reloading = 0; P.fireCd = 0;
    P.mag[P.active] = P.def.mag;
    P.reserve[P.active] = 90;
    cfg.tag;
  }, setup);
  /* Dispatch a real MouseEvent on the canvas: it goes through the same addEventListener handler,
     but is unaffected by Puppeteer's mouse state machine and can be repeated. */
  await page.evaluate(() => {
    document.getElementById('view')
      .dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  });
  const fired = await page.evaluate(() => {
    const g = window.__game;
    const before = g.stats.shots;
    g.advance(1 / 60, 1 / 60);                   // advance one frame at a fixed timestep
    return g.stats.shots - before;
  });
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  });
  return fired;
}

const t2 = {
  sidearmReal: { mode: 'SEMI', fired: await fireOnceReal({ sidearm: true }) },
  AUTO: await fireOnceReal({ mode: 'AUTO' }),
  SEMI: await fireOnceReal({ mode: 'SEMI' }),
  PUMP: await fireOnceReal({ mode: 'PUMP' }),
  REVOLVER: await fireOnceReal({ mode: 'REVOLVER' }),
};
check('P0-2 Default sidearm P9 (SEMI) can fire a round',
  t2.sidearmReal.fired >= 1,
  'mode=' + t2.sidearmReal.mode + ', rounds from one real click=' + t2.sidearmReal.fired);
check('P0-2 AUTO mode can fire a round', t2.AUTO >= 1, 'rounds=' + t2.AUTO);
check('P0-2 SEMI mode can fire a round', t2.SEMI >= 1, 'rounds=' + t2.SEMI);
check('P0-2 PUMP mode can fire a round', t2.PUMP >= 1, 'rounds=' + t2.PUMP);
check('P0-2 REVOLVER mode can fire a round', t2.REVOLVER >= 1, 'rounds=' + t2.REVOLVER);

/* ---------------- P0-3 The D key and the debug panel ---------------- */
await page.evaluate(() => {
  const g = window.__game;
  g.testMode = true;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0; g.player.pitch = 0; g.player.ads = 0;
  g.setCursorMode(true);                       // equivalent to pressing Alt to release the mouse
  const dbg = document.getElementById('debug-panel');
  if (dbg) dbg.classList.add('hidden');
});
await wait(200);
await page.keyboard.down('KeyD');
await wait(220);
const t3 = await page.evaluate(() => {
  const g = window.__game;
  const x0 = g.player.pos.x;
  for (let i = 0; i < 30; i++) g.advance(1 / 60, 1 / 60);
  const dbg = document.getElementById('debug-panel');
  const res = {
    movedX: +(g.player.pos.x - x0).toFixed(3),
    keySeen: g.input.keys.has('KeyD'),
    panelOpen: dbg ? !dbg.classList.contains('hidden') : false,   // missing element = not shown
  };
  g.input.keys.clear();
  g.setCursorMode(false);
  return res;
});
await page.keyboard.up('KeyD');
await wait(150);
check('P0-3 D strafes right in Alt cursor mode', t3.movedX > 0.5,
  'x displacement=' + t3.movedX + 'm, key received by game=' + t3.keySeen);
check('P0-3 D does not open the debug panel in Alt cursor mode', t3.panelOpen === false, 'panelOpen=' + t3.panelOpen);

/* ---------------- P0-4 Pause→abort→redeploy ---------------- */
/* Read the paused flag first, then use the real rAF main loop to verify freezing
   — calling advance() directly bypasses the ts=0 in loop() and cannot detect freezing */
const t4a = await page.evaluate(() => {
  const g = window.__game;
  g.testMode = false;         // only the real main loop can verify "is it frozen"
  g.togglePause(true);
  const afterPause = g.paused;
  g.abort();
  g.deploy(g.loadout);
  const afterDeploy = g.paused;
  g.input.keys.clear();
  g.input.keys.add('KeyW');
  window.__z0 = g.player.pos.z;
  return { afterPause, afterDeploy };
});
await wait(2500);   // let the real main loop run (if paused is not reset, dt stays 0 and displacement is exactly 0)
const t4 = await page.evaluate(() => {
  const g = window.__game;
  const moved = +Math.abs(g.player.pos.z - window.__z0).toFixed(3);
  g.input.keys.clear();
  return { moved, pausedNow: g.paused };
});
check('P0-4 paused=true after pausing (precondition holds)', t4a.afterPause === true, 'paused=' + t4a.afterPause);
check('P0-4 paused is reset after abort→redeploy', t4a.afterDeploy === false, 'paused=' + t4a.afterDeploy);
check('P0-4 The new run advances normally (not frozen, real main loop)', t4.moved > 0.02,
  'real displacement=' + t4.moved + 'm (exactly 0 when frozen), current paused=' + t4.pausedNow);

/* ---------------- P0-5 D must stay alive in the pause menu ---------------- */
/* The pause menu does not change game.state (still 'play'); it only sets paused.
   If ownership is decided by state alone, D can neither open the panel nor strafe while paused → dead key. */
async function panelOpenAfterD() {
  return page.evaluate(() => {
    const dbg = document.getElementById('debug-panel');
    return dbg ? !dbg.classList.contains('hidden') : false;
  });
}
async function pressD() {
  await page.keyboard.down('KeyD');
  await wait(200);
  await page.keyboard.up('KeyD');
  await wait(120);
}

await page.evaluate(() => {
  const g = window.__game;
  g.testMode = true;
  const dbg = document.getElementById('debug-panel');
  if (dbg) dbg.classList.add('hidden');
  g.togglePause(true);                       // enter the pause menu: state is still 'play'
});
await wait(200);
const t5state = await page.evaluate(() => ({
  state: window.__game.state,
  paused: window.__game.paused,
}));
await pressD();
const t5open = await panelOpenAfterD();
check('P0-5 Precondition: state is still play and paused=true in the pause menu',
  t5state.state === 'play' && t5state.paused === true,
  'state=' + t5state.state + ' paused=' + t5state.paused);
check('P0-5 D opens the debug panel in the pause menu (not a dead key)', t5open === true, 'panelOpen=' + t5open);

/* Reverse: during an operation (not paused) D must still belong to the game and must not open the panel */
await page.evaluate(() => {
  const g = window.__game;
  g.togglePause(false);                      // back into the operation
  const dbg = document.getElementById('debug-panel');
  if (dbg) dbg.classList.add('hidden');
  g.input.keys.clear();
});
await wait(200);
await pressD();
const t5play = await page.evaluate(() => {
  const dbg = document.getElementById('debug-panel');
  return {
    panelOpen: dbg ? !dbg.classList.contains('hidden') : false,
    keySeen: window.__game.input.keys.has('KeyD'),
  };
});
await page.evaluate(() => { window.__game.input.keys.clear(); });
check('P0-5 D does not open the panel during an operation (still belongs to the game)', t5play.panelOpen === false, 'panelOpen=' + t5play.panelOpen);

/* ---------------- P0-6 elementDone must be consumed (bounding overwatch converges) ---------------- */
/* Once both teams are in position, boundPhase must not keep flipping every 5.5s forever
   (the old implementation only wrote elementDone, so it kept flipping and repeatedly cleared the paths of members already in position). */
const t6 = await page.evaluate(() => {
  const g = window.__game;
  g.testMode = true;
  g.suspects.forEach((s, i) => { s.pos.x = 900; s.pos.z = 900 + i; });   // exclude engagement interference
  g.issueClearAt(0, -12);
  const wp = g.squadWaypoint;
  const alive = g.squad.filter((m) => m.alive);
  for (const m of alive) { m.pos.x = wp.x; m.pos.z = wp.z; }             // put everyone on the waypoint
  for (const m of alive) g.onElementArrived(m);                          // both teams report arrival
  const done = g.elementDone.slice();
  /* Count flips instead of comparing first and last phase — the old implementation flipped every frame,
     and after 480 frames it happened to return to the original phase, so comparing only endpoints would falsely pass. */
  let flips = 0, prev = g.boundPhase;
  for (let i = 0; i < 60 * 8; i++) {                                     // advance 8 s > the 5.5 s timer
    g.advance(1 / 60, 1 / 60);
    if (g.boundPhase !== prev) { flips++; prev = g.boundPhase; }
  }
  g.squadOrder = 'hold'; g.squadWaypoint = null;
  return { done, flips };
});
check('P0-6 elementDone is set and stays set after both teams arrive',
  t6.done[0] === true && t6.done[1] === true, 'elementDone=' + JSON.stringify(t6.done));
check('P0-6 Bounding overwatch converges: boundPhase stops flipping once both teams are in position (advance 8s)',
  t6.flips === 0,
  'flips=' + t6.flips + ' (the old implementation flipped every frame, reaching hundreds within 8 s)');

await suite.finish();
