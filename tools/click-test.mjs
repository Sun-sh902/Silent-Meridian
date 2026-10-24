/* ============================================================
   tools/click-test.mjs — verify with real Chrome that UI buttons are genuinely clickable
   Usage: node tools/click-test.mjs
   ============================================================ */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Suite, ROOT as root } from './harness.mjs';

const suite = new Suite('click-test');
const server = await suite.serve({ port: 8199 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--allow-file-access-from-files'],
  defaultViewport: { width: 1440, height: 900 },
});

const results = suite.results;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function step(name, fn) {
  try {
    const detail = await fn();
    suite.check(name, true, detail || '');
  } catch (e) {
    suite.check(name, false, e.message);
  }
}

async function newPage(opts) {
  return suite.newPage(opts);   // page errors are collected by Suite and counted as failures
}

/** Click and report hit info: it only counts if the click lands on the element itself */
async function clickInfo(page, sel) {
  const info = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const cs = getComputedStyle(el);
    return {
      hitSelf: top ? (top === el || el.contains(top)) : false,
      top: top ? (top.id || String(top.className) || top.tagName) : null,
      pointerEvents: cs.pointerEvents,
    };
  }, sel);
  assert(info, 'element missing: ' + sel);
  await page.click(sel);
  return info;
}

/* ============ Scenario A: local server build, full user path ============ */
/* This is the only suite that really requests pointer lock: the subject of the assertion is "clicks don't leak to the HUD while locked".
   The cost is that it owns the system cursor while running (see the note on newPage in harness.mjs). */
const page = await newPage({ pointerLock: true });
await page.goto('http://127.0.0.1:8199/', { waitUntil: 'load' });
await wait(900);

await step('title → briefing', async () => {
  const i = await clickInfo(page, '[data-action="screen"][data-screen="briefing"]');
  await wait(300);
  const on = await page.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
  assert(on, `briefing not shown (hitSelf=${i.hitSelf} top=${i.top})`);
  return `hitSelf=${i.hitSelf}`;
});

await step('briefing → loadout', async () => {
  const i = await clickInfo(page, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
  await wait(300);
  const on = await page.evaluate(() => !document.querySelector('#screen-loadout').classList.contains('hidden'));
  assert(on, `loadout not shown (hitSelf=${i.hitSelf} top=${i.top})`);
  return `hitSelf=${i.hitSelf}`;
});

await step('loadout: pick VK-12 shotgun', async () => {
  const before = await page.evaluate(() => window.__game.screens.loadout.primary);
  await clickInfo(page, '#primary-list .pick[data-id="vk12"]');
  await wait(200);
  const after = await page.evaluate(() => window.__game.screens.loadout.primary);
  assert(after === 'vk12', `selection not applied: ${before} → ${after}`);
  return `${before} → ${after}`;
});

await step('loadout: pick smoke', async () => {
  await clickInfo(page, '#gadget-list .pick[data-id="smoke"]');
  await wait(150);
  const g = await page.evaluate(() => window.__game.screens.loadout.gadget);
  assert(g === 'smoke', 'gadget selection not applied: ' + g);
  return g;
});

await step('click Deploy', async () => {
  await clickInfo(page, '#btn-deploy');
  await wait(1800);
  const st = await page.evaluate(() => ({
    state: window.__game.state,
    hud: !document.querySelector('#hud').classList.contains('hidden'),
  }));
  assert(st.state === 'play', 'did not enter play state: ' + st.state);
  assert(st.hud, 'HUD not shown');
  return `state=${st.state}`;
});

await step('clicks under pointer lock do not leak to HUD buttons', async () => {
  const before = await page.evaluate(() => window.__game.squadOrder);
  const locked = await page.evaluate(() => !!document.pointerLockElement);
  await page.click('#command-bar .cmd[data-order="hold"]');
  await wait(350);
  const after = await page.evaluate(() => window.__game.squadOrder);
  if (locked) {
    // while locked clicks go to the canvas and the order must not apply (which is why Alt exists)
    assert(after === before, 'click leaked through to the HUD under pointer lock: ' + before + ' -> ' + after);
  } else {
    // when the browser doesn't grant pointer lock, the click should apply directly
    assert(after === 'hold', 'click should apply without pointer lock, got ' + after);
  }
  return 'locked=' + locked + ', order ' + before + ' -> ' + after;
});

await step('Alt frees the cursor → cursor mode', async () => {
  await page.keyboard.press('Alt');
  await wait(400);
  const st = await page.evaluate(() => ({
    cursorMode: window.__game.cursorMode,
    locked: !!document.pointerLockElement,
    hint: document.querySelector('#cursor-hint').classList.contains('on'),
  }));
  assert(st.cursorMode, 'Alt did not enter cursor mode');
  assert(!st.locked, 'pointer still locked');
  assert(st.hint, 'HUD did not show the cursor-free hint');
  return `cursorMode=${st.cursorMode} locked=${st.locked}`;
});

for (const [cmd, label] of [['hold', 'Hold'], ['follow', 'Follow'], ['regroup', 'Regroup'], ['clear', 'Move & clear']]) {
  await step(`cursor mode: click HUD order [${label}]`, async () => {
    const i = await clickInfo(page, `#command-bar .cmd[data-order="${cmd}"]`);
    await wait(300);
    const order = await page.evaluate(() => window.__game.squadOrder);
    assert(i.hitSelf, `click intercepted by ${i.top} (pointer-events:${i.pointerEvents})`);
    assert(order === cmd, `order not applied: squadOrder=${order}, expected ${cmd}`);
    return `squadOrder=${order}`;
  });
}

await step('order really reaches every squad member', async () => {
  await clickInfo(page, '#command-bar .cmd[data-order="hold"]');
  await wait(600);
  const states = await page.evaluate(() => window.__game.squad.map((m) => m.lastOrder));
  assert(states.every((s) => s === 'hold'), 'members did not receive hold: ' + states.join(','));
  return states.join(',');
});

await step('click the view → back to mouse look (leave cursor mode)', async () => {
  await page.mouse.click(720, 300);
  await wait(500);
  const st = await page.evaluate(() => ({ c: window.__game.cursorMode, locked: !!document.pointerLockElement }));
  assert(!st.c, 'did not leave cursor mode');
  return `cursorMode=${st.c} locked=${st.locked}`;
});

await step('Tab opens the tactical map', async () => {
  await page.keyboard.press('Tab');
  await wait(400);
  assert(await page.evaluate(() => window.__game.tacmap.open), 'map not open');
  const size = await page.evaluate(() => {
    const c = document.querySelector('#tacmap-canvas');
    return `${c.width}x${c.height}`;
  });
  return 'canvas ' + size;
});

await step('click inside the tactical map sets a waypoint', async () => {
  const box = await page.$eval('#tacmap-canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.35 };
  });
  await page.mouse.click(box.x, box.y);
  await wait(300);
  const after = await page.evaluate(() => window.__game.squadWaypoint);
  assert(after, 'waypoint not placed');
  return `waypoint=(${after.x.toFixed(1)}, ${after.z.toFixed(1)})`;
});

await step('Tab closes the tactical map', async () => {
  await page.keyboard.press('Tab');
  await wait(300);
  assert(!(await page.evaluate(() => window.__game.tacmap.open)), 'map not closed');
});

await step('Esc pause → click Resume', async () => {
  await page.keyboard.press('Escape');
  await wait(350);
  assert(await page.evaluate(() => !document.querySelector('#screen-pause').classList.contains('hidden')), 'pause screen not shown');
  await clickInfo(page, '#btn-resume');
  await wait(300);
  assert(await page.evaluate(() => window.__game.paused === false), 'did not resume');
});

await step('Esc pause → click Abort to main menu', async () => {
  await page.keyboard.press('Escape');
  await wait(300);
  await clickInfo(page, '#btn-abort');
  await wait(400);
  const t = await page.evaluate(() => ({
    title: !document.querySelector('#screen-title').classList.contains('hidden'),
    state: window.__game.state,
  }));
  assert(t.title && t.state === 'menu', `did not return to main menu state=${t.state} title=${t.title}`);
});

await step('main menu Controls → close', async () => {
  await clickInfo(page, '#btn-controls');
  await wait(300);
  assert(await page.evaluate(() => !document.querySelector('#screen-help').classList.contains('hidden')), 'controls not shown');
  await clickInfo(page, '#btn-help-close');
  await wait(250);
  assert(await page.evaluate(() => !document.querySelector('#screen-title').classList.contains('hidden')), 'did not return to title after closing');
});

/* ============ Scenario B: single-file build (file://) ============ */
const distPath = join(root, 'dist', 'silent-meridian.html');
if (existsSync(distPath)) {
  const p2 = await newPage();
  await p2.goto('file://' + distPath, { waitUntil: 'load' });
  await wait(1200);
  await step('single file: title → briefing', async () => {
    const i = await clickInfo(p2, '[data-action="screen"][data-screen="briefing"]');
    await wait(300);
    const on = await p2.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
    assert(on, `briefing not shown (hitSelf=${i.hitSelf} top=${i.top})`);
    return `hitSelf=${i.hitSelf}`;
  });
  await step('single file: loadout → deploy → order buttons', async () => {
    await clickInfo(p2, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
    await wait(250);
    await clickInfo(p2, '#btn-deploy');
    await wait(1800);
    assert(await p2.evaluate(() => window.__game.state === 'play'), 'did not enter the mission');
    await p2.keyboard.press('Alt');          // HUD is only clickable once the cursor is freed
    await wait(350);
    assert(await p2.evaluate(() => window.__game.cursorMode), 'Alt did not enter cursor mode');
    await clickInfo(p2, '#command-bar .cmd[data-order="hold"]');
    await wait(300);
    const order = await p2.evaluate(() => window.__game.squadOrder);
    assert(order === 'hold', 'order not applied: ' + order);
    return 'squadOrder=' + order;
  });
  await p2.close();
} else {
  suite.check('single-file tests', false, 'dist/silent-meridian.html missing; run node build.mjs first');
}

/* ============ Scenario C: index.html opened directly from file:// (the path a user reported) ============ */
const indexPath = join(root, 'index.html');
{
  const p3 = await newPage();
  await p3.goto('file://' + indexPath, { waitUntil: 'load' });
  await wait(2600);
  await step('file:// index.html: main script really runs', async () => {
    const d = await p3.evaluate(() => window.__SM_DEBUG && {
      booted: window.__SM_DEBUG.booted,
      loader: window.__SM_DEBUG.loader,
      mainLoaded: window.__SM_DEBUG.mainLoaded,
      mainError: window.__SM_DEBUG.mainError,
      handlerReady: window.__SM_DEBUG.handlerReady,
      errorVisible: !document.querySelector('#boot-error').classList.contains('hidden'),
    });
    assert(d, 'window.__SM_DEBUG missing — the bootstrap never ran');
    assert(d.mainLoaded, `main script not loaded (loader=${d.loader} err=${d.mainError} rescue visible=${d.errorVisible})`);
    assert(d.handlerReady, 'action handler not registered');
    return `loader=${d.loader}`;
  });
  await step('file:// index.html: title buttons clickable', async () => {
    const i = await clickInfo(p3, '[data-action="screen"][data-screen="briefing"]');
    await wait(300);
    const on = await p3.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
    assert(on, `briefing not shown (hitSelf=${i.hitSelf} top=${i.top})`);
    return `hitSelf=${i.hitSelf}`;
  });
  await step('file:// index.html: order buttons clickable after deploy', async () => {
    await clickInfo(p3, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
    await wait(250);
    await clickInfo(p3, '#btn-deploy');
    await wait(1800);
    assert(await p3.evaluate(() => window.__game.state === 'play'), 'did not enter the mission');
    await p3.keyboard.press('Alt');
    await wait(350);
    await clickInfo(p3, '#command-bar .cmd[data-order="hold"]');
    await wait(300);
    const order = await p3.evaluate(() => window.__game.squadOrder);
    assert(order === 'hold', 'order not applied: ' + order);
    return 'squadOrder=' + order;
  });
  await step('D opens the debug panel and shows recent clicks', async () => {
    // back to the menu first; press D with the pointer unlocked
    await p3.evaluate(() => { if (document.exitPointerLock) document.exitPointerLock(); });
    await wait(300);
    /* P0-3 regression guard: in mission D belongs to the game (strafe right) and must not toggle the panel */
  await p3.keyboard.press('KeyD');
  await wait(250);
  const dOpened = await p3.evaluate(() => {
    const p = document.querySelector('#debug-panel');
    return p ? !p.classList.contains('hidden') : false;
  });
  assert(!dOpened, 'D in mission must not open the debug panel (P0-3 regression)');
  /* in mission, use ~ to open the panel */
  await p3.keyboard.press('Backquote');
    await wait(300);
    const d = await p3.evaluate(() => {
      const p = document.querySelector('#debug-panel');
      return { visible: p && !p.classList.contains('hidden'), text: p ? p.innerText : '' };
    });
    assert(d.visible, 'debug panel not shown');
    assert(/Bootstrap ran/.test(d.text), 'panel is missing "Bootstrap ran"');
    assert(/✓ loaded/.test(d.text), 'panel does not show the main script as loaded');
    assert(/#command-bar|action=order|order/.test(d.text), 'panel did not record the click');
    return d.text.split('\n').slice(0, 5).join(' | ');
  });
  await p3.close();
}

await suite.finish();
