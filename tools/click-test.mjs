/* ============================================================
   tools/click-test.mjs — verify in real Chrome that interface buttons are actually clickable
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

async function newPage() {
  return suite.newPage();   // page errors are collected centrally by Suite and counted as failures
}

/** Click and report hit info: only a hit on itself counts as a real click */
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
  assert(info, 'Element does not exist: ' + sel);
  await page.click(sel);
  return info;
}

/* ============ Scenario A: local server build, full user path ============ */
const page = await newPage();
await page.goto('http://127.0.0.1:8199/', { waitUntil: 'load' });
await wait(900);

await step('Title → operation briefing', async () => {
  const i = await clickInfo(page, '[data-action="screen"][data-screen="briefing"]');
  await wait(300);
  const on = await page.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
  assert(on, `Briefing did not appear (hitSelf=${i.hitSelf} top=${i.top})`);
  return `hitSelf=${i.hitSelf}`;
});

await step('Briefing → loadout', async () => {
  const i = await clickInfo(page, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
  await wait(300);
  const on = await page.evaluate(() => !document.querySelector('#screen-loadout').classList.contains('hidden'));
  assert(on, `Loadout did not appear (hitSelf=${i.hitSelf} top=${i.top})`);
  return `hitSelf=${i.hitSelf}`;
});

await step('Loadout: select the VK-12 shotgun', async () => {
  const before = await page.evaluate(() => window.__game.screens.loadout.primary);
  await clickInfo(page, '#primary-list .pick[data-id="vk12"]');
  await wait(200);
  const after = await page.evaluate(() => window.__game.screens.loadout.primary);
  assert(after === 'vk12', `Selection did not take effect: ${before} → ${after}`);
  return `${before} → ${after}`;
});

await step('Loadout: select smoke grenade', async () => {
  await clickInfo(page, '#gadget-list .pick[data-id="smoke"]');
  await wait(150);
  const g = await page.evaluate(() => window.__game.screens.loadout.gadget);
  assert(g === 'smoke', 'Gadget selection did not take effect: ' + g);
  return g;
});

await step('Click "Enter the port" to deploy', async () => {
  await clickInfo(page, '#btn-deploy');
  await wait(1800);
  const st = await page.evaluate(() => ({
    state: window.__game.state,
    hud: !document.querySelector('#hud').classList.contains('hidden'),
  }));
  assert(st.state === 'play', 'Did not enter play state: ' + st.state);
  assert(st.hud, 'HUD is not visible');
  return `state=${st.state}`;
});

await step('Clicks do not pass through to HUD buttons under pointer lock', async () => {
  const before = await page.evaluate(() => window.__game.squadOrder);
  const locked = await page.evaluate(() => !!document.pointerLockElement);
  await page.click('#command-bar .cmd[data-order="hold"]');
  await wait(350);
  const after = await page.evaluate(() => window.__game.squadOrder);
  if (locked) {
    // While locked, clicks go to the canvas and orders must not take effect (exactly why Alt is needed)
    assert(after === before, 'A click passed through to the HUD under pointer lock: ' + before + ' -> ' + after);
  } else {
    // If the browser did not grant pointer lock, the click should take effect directly
    assert(after === 'hold', 'A click should take effect when the pointer is not locked; got ' + after);
  }
  return 'locked=' + locked + ', order ' + before + ' -> ' + after;
});

await step('Press Alt to release the mouse → cursor mode', async () => {
  await page.keyboard.press('Alt');
  await wait(400);
  const st = await page.evaluate(() => ({
    cursorMode: window.__game.cursorMode,
    locked: !!document.pointerLockElement,
    hint: document.querySelector('#cursor-hint').classList.contains('on'),
  }));
  assert(st.cursorMode, 'Alt did not enter cursor mode');
  assert(!st.locked, 'The pointer is still locked');
  assert(st.hint, 'The HUD does not indicate the mouse was released');
  return `cursorMode=${st.cursorMode} locked=${st.locked}`;
});

for (const [cmd, label] of [['hold', 'HOLD'], ['follow', 'FOLLOW'], ['regroup', 'REGROUP'], ['clear', 'MOVE & CLEAR']]) {
  await step(`Click the HUD order [${label}] in cursor mode`, async () => {
    const i = await clickInfo(page, `#command-bar .cmd[data-order="${cmd}"]`);
    await wait(300);
    const order = await page.evaluate(() => window.__game.squadOrder);
    assert(i.hitSelf, `Click intercepted by ${i.top} (pointer-events:${i.pointerEvents})`);
    assert(order === cmd, `Order did not take effect: squadOrder=${order}, expected ${cmd}`);
    return `squadOrder=${order}`;
  });
}

await step('Orders really reach every squad member', async () => {
  await clickInfo(page, '#command-bar .cmd[data-order="hold"]');
  await wait(600);
  const states = await page.evaluate(() => window.__game.squad.map((m) => m.lastOrder));
  assert(states.every((s) => s === 'hold'), 'Members did not receive hold: ' + states.join(','));
  return states.join(',');
});

await step('Click the view → restore mouse look (exit cursor mode)', async () => {
  await page.mouse.click(720, 300);
  await wait(500);
  const st = await page.evaluate(() => ({ c: window.__game.cursorMode, locked: !!document.pointerLockElement }));
  assert(!st.c, 'Did not exit cursor mode');
  return `cursorMode=${st.c} locked=${st.locked}`;
});

await step('Tab opens the tactical map', async () => {
  await page.keyboard.press('Tab');
  await wait(400);
  assert(await page.evaluate(() => window.__game.tacmap.open), 'Map did not open');
  const size = await page.evaluate(() => {
    const c = document.querySelector('#tacmap-canvas');
    return `${c.width}x${c.height}`;
  });
  return 'canvas ' + size;
});

await step('Clicking in the tactical map places a waypoint', async () => {
  const box = await page.$eval('#tacmap-canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.35 };
  });
  await page.mouse.click(box.x, box.y);
  await wait(300);
  const after = await page.evaluate(() => window.__game.squadWaypoint);
  assert(after, 'Waypoint was not placed');
  return `waypoint=(${after.x.toFixed(1)}, ${after.z.toFixed(1)})`;
});

await step('Tab closes the tactical map', async () => {
  await page.keyboard.press('Tab');
  await wait(300);
  assert(!(await page.evaluate(() => window.__game.tacmap.open)), 'Map did not close');
});

await step('Esc pauses → click "Resume operation"', async () => {
  await page.keyboard.press('Escape');
  await wait(350);
  assert(await page.evaluate(() => !document.querySelector('#screen-pause').classList.contains('hidden')), 'Pause screen did not appear');
  await clickInfo(page, '#btn-resume');
  await wait(300);
  assert(await page.evaluate(() => window.__game.paused === false), 'Could not resume');
});

await step('Esc pauses → click "Abort and return to main menu"', async () => {
  await page.keyboard.press('Escape');
  await wait(300);
  await clickInfo(page, '#btn-abort');
  await wait(400);
  const t = await page.evaluate(() => ({
    title: !document.querySelector('#screen-title').classList.contains('hidden'),
    state: window.__game.state,
  }));
  assert(t.title && t.state === 'menu', `Did not return to the main menu: state=${t.state} title=${t.title}`);
});

await step('Main menu "How to Play" → close', async () => {
  await clickInfo(page, '#btn-controls');
  await wait(300);
  assert(await page.evaluate(() => !document.querySelector('#screen-help').classList.contains('hidden')), 'Help screen did not appear');
  await clickInfo(page, '#btn-help-close');
  await wait(250);
  assert(await page.evaluate(() => !document.querySelector('#screen-title').classList.contains('hidden')), 'Did not return to the title after closing');
});

/* ============ Scenario B: single-file build (file://) ============ */
const distPath = join(root, 'dist', 'silent-meridian.html');
if (existsSync(distPath)) {
  const p2 = await newPage();
  await p2.goto('file://' + distPath, { waitUntil: 'load' });
  await wait(1200);
  await step('Single-file: title → briefing', async () => {
    const i = await clickInfo(p2, '[data-action="screen"][data-screen="briefing"]');
    await wait(300);
    const on = await p2.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
    assert(on, `Briefing did not appear (hitSelf=${i.hitSelf} top=${i.top})`);
    return `hitSelf=${i.hitSelf}`;
  });
  await step('Single-file: loadout → deploy → order button', async () => {
    await clickInfo(p2, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
    await wait(250);
    await clickInfo(p2, '#btn-deploy');
    await wait(1800);
    assert(await p2.evaluate(() => window.__game.state === 'play'), 'Did not enter the operation');
    await p2.keyboard.press('Alt');          // release the mouse before clicking the HUD
    await wait(350);
    assert(await p2.evaluate(() => window.__game.cursorMode), 'Alt did not enter cursor mode');
    await clickInfo(p2, '#command-bar .cmd[data-order="hold"]');
    await wait(300);
    const order = await p2.evaluate(() => window.__game.squadOrder);
    assert(order === 'hold', 'Order did not take effect: ' + order);
    return 'squadOrder=' + order;
  });
  await p2.close();
} else {
  suite.check('Single-file build test', false, 'dist/silent-meridian.html is missing; run node build.mjs first');
}

/* ============ Scenario C: index.html opened directly via file:// (the path users reported broken) ============ */
const indexPath = join(root, 'index.html');
{
  const p3 = await newPage();
  await p3.goto('file://' + indexPath, { waitUntil: 'load' });
  await wait(2600);
  await step('file:// index.html: the main script really executes', async () => {
    const d = await p3.evaluate(() => window.__SM_DEBUG && {
      booted: window.__SM_DEBUG.booted,
      loader: window.__SM_DEBUG.loader,
      mainLoaded: window.__SM_DEBUG.mainLoaded,
      mainError: window.__SM_DEBUG.mainError,
      handlerReady: window.__SM_DEBUG.handlerReady,
      errorVisible: !document.querySelector('#boot-error').classList.contains('hidden'),
    });
    assert(d, 'window.__SM_DEBUG does not exist — even the bootstrap did not run');
    assert(d.mainLoaded, `Main script did not load (loader=${d.loader} err=${d.mainError} promptVisible=${d.errorVisible})`);
    assert(d.handlerReady, 'Action handlers are not registered');
    return `loader=${d.loader}`;
  });
  await step('file:// index.html: title button is clickable', async () => {
    const i = await clickInfo(p3, '[data-action="screen"][data-screen="briefing"]');
    await wait(300);
    const on = await p3.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
    assert(on, `Briefing did not appear (hitSelf=${i.hitSelf} top=${i.top})`);
    return `hitSelf=${i.hitSelf}`;
  });
  await step('file:// index.html: order button is clickable after deployment', async () => {
    await clickInfo(p3, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
    await wait(250);
    await clickInfo(p3, '#btn-deploy');
    await wait(1800);
    assert(await p3.evaluate(() => window.__game.state === 'play'), 'Did not enter the operation');
    await p3.keyboard.press('Alt');
    await wait(350);
    await clickInfo(p3, '#command-bar .cmd[data-order="hold"]');
    await wait(300);
    const order = await p3.evaluate(() => window.__game.squadOrder);
    assert(order === 'hold', 'Order did not take effect: ' + order);
    return 'squadOrder=' + order;
  });
  await step('Press D to open the debug panel and show the latest click', async () => {
    // Return to the menu first; press D with the pointer unlocked
    await p3.evaluate(() => { if (document.exitPointerLock) document.exitPointerLock(); });
    await wait(300);
    /* P0-3 regression guard: during an operation D belongs to the game (strafe right) and must not toggle the panel */
  await p3.keyboard.press('KeyD');
  await wait(250);
  const dOpened = await p3.evaluate(() => {
    const p = document.querySelector('#debug-panel');
    return p ? !p.classList.contains('hidden') : false;
  });
  assert(!dOpened, 'D must not open the debug panel during an operation (P0-3 regression)');
  /* Use ~ to open the panel during an operation */
  await p3.keyboard.press('Backquote');
    await wait(300);
    const d = await p3.evaluate(() => {
      const p = document.querySelector('#debug-panel');
      return { visible: p && !p.classList.contains('hidden'), text: p ? p.innerText : '' };
    });
    assert(d.visible, 'Debug panel is not visible');
    assert(/Script executed/.test(d.text), 'Panel is missing "Script executed"');
    assert(/loaded/.test(d.text), 'Panel does not show the main script as loaded');
    assert(/#command-bar|action=order|order/.test(d.text), 'Panel did not record the click event');
    return d.text.split('\n').slice(0, 5).join(' | ');
  });
  await p3.close();
}

await suite.finish();
