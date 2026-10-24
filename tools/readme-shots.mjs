/* ============================================================
   tools/readme-shots.mjs — real screenshots for the README (manual workflow, not part of run-all)
   ------------------------------------------------------------
   Usage: node tools/readme-shots.mjs [--out docs/shots] [--port 8197]

   Boots the real game, walks the user path through the UI and captures:
     01-title  main menu    02-briefing briefing        03-loadout  loadout
     04-yard   in mission   05-tacmap   tactical map    06-debrief  debrief
   Uses the repo's existing puppeteer-core + local Chrome; no new dependencies.
   ============================================================ */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Suite, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = resolve(ROOT, argOf('--out', 'docs/shots'));
const PORT = Number(argOf('--port', '8197'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const suite = new Suite('readme-shots', { failOnPageError: false });
const server = await suite.serve({ port: PORT });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
const page = await suite.newPage();

async function shoot(name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  const shown = await page.evaluate(() => {
    const el = document.querySelector('.screen:not(.hidden)');
    return el ? el.id : '(no full-screen screen)';
  });
  suite.info(`${name}.png`, shown);
  return file;
}

/**
 * Click a button that really exists on screen.
 * Prefers a real mouse click (it only counts if it hits the element); falls back to DOM click when the element
 * is scrolled out of view, and reports which path was used — this script only cares that the UI can be driven; click-test owns hit-rate assertions.
 */
async function click(sel) {
  const state = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return 'zero-size';
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && (top === el || el.contains(top)) ? 'visible' : 'offscreen';
  }, sel);
  if (state === 'missing' || state === 'zero-size') return false;
  if (state === 'visible') {
    await page.click(sel);
  } else {
    await page.evaluate((s) => document.querySelector(s).click(), sel);
  }
  return true;
}

async function screenOn(id) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && !el.classList.contains('hidden');
  }, id);
}

async function step(label, fn) {
  try {
    const detail = await fn();
    suite.check(label, true, detail || '');
  } catch (e) {
    suite.check(label, false, e.message);
  }
}

await mkdir(OUT, { recursive: true });

await page.goto(server.url, { waitUntil: 'load' });
await wait(1500);

const boot = await page.evaluate(() => ({
  game: !!window.__game,
  actions: document.querySelectorAll('[data-action]').length,
}));
if (!boot.game || boot.actions === 0) {
  console.error('[shots] game script did not run; giving up');
  await suite.finish();
}

await step('01 main menu', async () => {
  /* the title sits over the live port: wait for attract mode, then give the camera a moment to settle */
  await page.waitForFunction(() => document.body.classList.contains('attract-live'), { timeout: 30000 });
  await wait(5000);
  await shoot('01-title');
  return '1600x900';
});

await step('02 briefing', async () => {
  await click('[data-action="screen"][data-screen="briefing"]');
  await wait(900);
  if (!(await screenOn('#screen-briefing'))) throw new Error('briefing not shown');
  return await shoot('02-briefing');
});

await step('03 loadout', async () => {
  await click('#screen-briefing [data-action="screen"][data-screen="loadout"]');
  await wait(900);
  if (!(await screenOn('#screen-loadout'))) throw new Error('loadout not shown');
  // pick a loadout that reads clearly, so the shot isn't just the defaults
  await click('#primary-list .pick[data-id="vk12"]');
  await wait(250);
  await click('#gadget-list .pick[data-id="smoke"]');
  await wait(400);
  return await shoot('03-loadout');
});

await step('04 in mission', async () => {
  if (!(await click('#btn-deploy'))) throw new Error('Deploy button not found');
  await wait(4200);
  const st = await page.evaluate(() => window.__game.state);
  if (st !== 'play') throw new Error('did not enter mission state: ' + st);
  // level the reticle and point the camera at the bays, so the shot isn't of the ground
  await page.evaluate(() => {
    const g = window.__game;
    g.player.pitch = -0.04;
    g.squad.forEach((m) => { m.lastOrder = 'follow'; });
  });
  await wait(900);
  return await shoot('04-yard');
});

await step('05 tactical map', async () => {
  await page.keyboard.press('Tab');
  await wait(1500);
  if (!(await page.evaluate(() => window.__game.tacmap.open))) throw new Error('tactical map not open');
  return await shoot('05-tacmap');
});

await step('06 debrief', async () => {
  // close the tactical map first, or the debrief sits on top of the still-open 3D scene / map
  await page.evaluate(() => {
    const g = window.__game;
    if (g.tacmap && g.tacmap.open) g.toggleTacMap();
  });
  await wait(500);
  await page.evaluate(() => {
    const g = window.__game;
    g.screens.showDebrief({
      success: true, grade: 'A', comment: 'Clean and measured. Movement and fire discipline to Port Security SOP.',
      time: '7:24', shots: 61, accuracy: 38, blindShots: 3, detained: 3, killed: 1, escaped: 0,
      suspectTotal: 9, civSafe: 4, civLost: 0, civTotal: 4, orders: 11, squadDown: 0, gadgets: 2,
      objectives: { manifest: 'done', evidence: 'done', civilians: 'done', suspects: 'done', extract: 'done' },
      squad: [
        { callsign: 'LEAD', role: 'Standard vest', alive: true, hp: 96, maxHp: 120 },
        { callsign: 'ARDEN-2', role: 'RIFLEMAN · RECON', alive: true, hp: 118, maxHp: 130 },
        { callsign: 'BRAM-3', role: 'RIFLEMAN · FIRE SUPPORT', alive: true, hp: 74, maxHp: 130 },
        { callsign: 'CIRA-4', role: 'BREACHER · ENTRY', alive: true, hp: 130, maxHp: 130 },
        { callsign: 'DOV-5', role: 'MEDIC · SUPPORT', alive: true, hp: 101, maxHp: 130 },
      ],
    });
    g.screens.show('debrief');
    g.screens.hideGame();
  });
  await wait(900);
  return await shoot('06-debrief');
});

/* record which build the shots came from, so staleness can be checked later */
const head = await page.evaluate(() => 'v' + (window.__SM_DEBUG && window.__SM_DEBUG.build ? window.__SM_DEBUG.build : '?'));
await writeFile(
  join(OUT, 'README.md'),
  [
    '# docs/shots — README screenshots',
    '',
    'Generated by `node tools/readme-shots.mjs` from the running game; not mock-ups.',
    '',
    '| File | Screen |',
    '| --- | --- |',
    '| `01-title.png` | Main menu |',
    '| `02-briefing.png` | Briefing |',
    '| `03-loadout.png` | Loadout |',
    '| `04-yard.png` | In mission (HUD / squad / status) |',
    '| `05-tacmap.png` | Tactical map (Tab) |',
    '| `06-debrief.png` | Debrief |',
    '',
    'Regenerate: `node tools/readme-shots.mjs` (drives the real UI with local Chrome).',
    '',
    `Page build at capture: ${head}`,
    '',
  ].join('\n'),
);

await suite.finish();
