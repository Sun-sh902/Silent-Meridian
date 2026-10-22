/* ============================================================
   tools/fixes-test.mjs — targeted acceptance for four bugs
     1) The loadout screen must have no ambient background sound
     2) The target card shows a teammate when facing a teammate
     3) Friendly fire is off (but civilians can still be hit; ROE preserved)
     4) Map: enemies = orange dots, events = yellow dots, player and teammates = blue
   Usage: node tools/fixes-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('fixes-test');
const server = await suite.serve({ port: 8204 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await suite.newPage();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n = 2) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const step = () => { if (++i >= k) res(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);
const results = suite.results;
const check = (name, ok, detail) => suite.check(name, ok, detail);

/* ============ 1. Loadout screen must have no sustained sound ============ */
await page.goto('http://127.0.0.1:8204/', { waitUntil: 'load' });
await wait(800);

await page.evaluate(() => window.__game.screens.show('loadout'));
await wait(300);
await page.click('#primary-list .pick[data-id="k9"]');   // this action calls init() on audio
await wait(400);

let a = await page.evaluate(() => ({
  ctxCount: window.__game.audio.stats().ctxCount,
  state: window.__game.audio.ctx ? window.__game.audio.ctx.state : 'none',
  live: window.__game.audio.stats().liveNodes,
}));
check('Loadout: audio context is created (button sounds available)', a.ctxCount === 1, `ctxCount=${a.ctxCount} state=${a.state}`);
/* Note: this used to assert "rain did not start". Rain and ambience were removed entirely,
   but the invariant that matters is "no sustained sound is playing in menus" —
   the original bug (port ambience audible on the loadout screen) was essentially sustained audio not being released on screen changes.
   So this now checks the number of live audio nodes directly. */
check('Loadout: no sustained sound is playing', a.live === 0, `liveNodes=${a.live}`);

await page.click('#btn-deploy');
await wait(2600);

/* ============ 2. Facing a teammate → shown as a teammate ============ */
await page.evaluate(() => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0; g.player.pitch = 0;
  g.player.ads = 1;
  const m = g.squad[0];
  m.pos.x = 0; m.pos.z = -6;              // 6 m straight ahead
  m.y = 0;
  g.suspects.forEach((s) => { s.pos.x = 200; s.pos.z = 200; });
  g.civilians.forEach((c) => { c.pos.x = 200; c.pos.z = 200; });
});
await frames(3);
await wait(500);
const friend = await page.evaluate(() => {
  const g = window.__game;
  const card = document.querySelector('#target-card');
  return {
    kind: g.observeTarget ? g.observeTarget.kind : null,
    ident: g.observeTarget ? g.observeTarget.ident : null,
    hidden: card.classList.contains('hidden'),
    cls: card.className,
    title: document.querySelector('#tc-class').textContent.trim(),
    note: document.querySelector('#tc-note').textContent.trim(),
    callsign: g.squad[0].callsign,
  };
});
check('Facing a teammate: target card resolved as friendly', friend.kind === 'squad' && friend.ident === 1,
  `kind=${friend.kind} ident=${friend.ident}`);
check('Facing a teammate: shows the callsign instead of UNKNOWN CONTACT', !friend.hidden && friend.cls.includes('friendly') &&
  friend.title === friend.callsign, `"${friend.title}" class=${friend.cls}`);

/* ============ 3. Friendly fire is off ============ */
const ff = await page.evaluate(async () => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0; g.player.pitch = 0;
  const mate = g.squad[1];
  mate.pos.x = 0; mate.pos.z = -5;
  const foe = g.suspects[0];
  foe.pos.x = 0; foe.pos.z = -11; foe.hp = foe.maxHp; foe.alive = true;
  const civ = g.civilians[0];
  civ.pos.x = 200; civ.pos.z = 200;          // move out of the ray first to test separately
  const before = { mate: mate.hp, foe: foe.hp, civ: civ.hp };
  g.player.mag.primary = 30; g.player.reloading = 0;
  for (let i = 0; i < 5; i++) { g.player.fireCd = 0; g.player.recoil.pitch = 0; g.player.recoil.yaw = 0; g.player.fireOnce(); }
  const afterMate = { mate: mate.hp, foe: foe.hp };

  // Case two: put a civilian directly in the line of fire (teammate and enemy moved aside) to verify ROE still applies
  mate.pos.x = 200; mate.pos.z = 200;
  foe.pos.x = 200; foe.pos.z = 200;
  civ.pos.x = 0; civ.pos.z = -6; civ.hp = civ.maxHp; civ.alive = true;
  const civBefore = civ.hp;
  g.player.mag.primary = 30;
  for (let i = 0; i < 5; i++) { g.player.fireCd = 0; g.player.recoil.pitch = 0; g.player.recoil.yaw = 0; g.player.fireOnce(); }
  return { before, afterMate, civBefore, civAfter: civ.hp };
});
check('Friendly fire: a teammate in the line of fire takes no damage', ff.afterMate.mate === ff.before.mate,
  `Teammate HP ${ff.before.mate} → ${ff.afterMate.mate}`);
check('Bullets still hit the enemy after passing through a teammate', ff.afterMate.foe < ff.before.foe,
  `Enemy HP ${ff.before.foe} → ${ff.afterMate.foe}`);
check('Civilians can still be hit by mistake (rules of engagement intact)', ff.civAfter < ff.civBefore,
  `Civilian HP ${ff.civBefore} → ${ff.civAfter}`);

const guard = await page.evaluate(() => {
  const g = window.__game;
  const mate = g.squad[2];
  const hp = mate.hp;
  mate.takeDamage(50, g.player);           // go through the damage entry to verify the backstop
  return { hp, after: mate.hp };
});
check('Friendly fire: damage-entry backstop works', guard.after === guard.hp, `HP ${guard.hp} → ${guard.after}`);

/* ============ 4. Map colors and event dots ============ */
const map = await page.evaluate(() => {
  const g = window.__game;
  g.mapEvents.length = 0;
  g.onSuspectAlerted(g.suspects[0], { x: 0, y: 1.5, z: 0 });     // alarm → yellow
  g.civilianCall(g.civilians[1]);                                 // civilian found → yellow
  g.onObjectiveTaken('manifest', g.objectiveProps.manifest);      // intel → yellow
  g.toggleTacMap();
  return {
    events: g.mapEvents.map((e) => e.kind + ':' + e.label),
    legend: document.querySelector('.tm-legend').innerText.replace(/\s+/g, ' ').trim(),
    colors: { enemy: '#ff9a3c', event: '#ffd447', friendly: '#4ea8ff' },
  };
});
check('Map event dots recorded (yellow)', map.events.length >= 3, map.events.join(' | '));
check('Legend updated to blue/orange/yellow', /blue/i.test(map.legend) && /orange/i.test(map.legend) && /yellow/i.test(map.legend),
  map.legend.slice(0, 80));

const colors = await page.evaluate(() => {
  const sw = (n) => getComputedStyle(document.querySelector('.sw.' + n)).backgroundColor;
  return { suspect: sw('suspect'), event: sw('event'), self: sw('self') };
});
check('Legend swatches: enemies=orange / events=yellow / friendlies=blue',
  colors.suspect === 'rgb(255, 154, 60)' && colors.event === 'rgb(255, 212, 71)' && colors.self === 'rgb(78, 168, 255)',
  JSON.stringify(colors));

const tacrender = await page.evaluate(() => {
  try { window.__game.tacmap.render(); return 'ok'; } catch (e) { return 'error: ' + e.message; }
});
check('Tactical map renders without errors (including the event layer)', tacrender === 'ok', tacrender);

/* ============ 5. No sustained sound left after aborting the operation ============ */
await page.evaluate(() => {
  const g = window.__game;
  g.toggleTacMap();
  g.abort();
});
await wait(900);   // give short sounds time to finish naturally
const off = await page.evaluate(() => ({
  live: window.__game.audio.stats().liveNodes,
  ctxCount: window.__game.audio.stats().ctxCount,
}));
check('Return to main menu: no leftover audio nodes (all sustained sounds released)', off.live === 0, `liveNodes=${off.live}`);
check('Return to main menu: AudioContext stays at 1 (not recreated)', off.ctxCount === 1, `ctxCount=${off.ctxCount}`);

await suite.finish();
