/* ============================================================
   tools/verify-live.mjs — verify that both the live Pages site and the local dist single file actually run
   ------------------------------------------------------------
   Usage: node tools/verify-live.mjs [--url https://...] [--file dist/silent-meridian.html]

   Not a regular regression suite (it needs the internet); a one-off release acceptance check:
     1) open the live Pages site → assert the game script runs, actions register, briefing is reachable, deploy really works
     2) open the local dist/ single file (file://) → assert the same, proving clone-and-double-click works
   ============================================================ */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Suite, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = argOf('--url', 'https://sun-sh902.github.io/silent-meridian/');
const FILE_ = argOf('--file', 'dist/silent-meridian.html');

const suite = new Suite('verify-live', { failOnPageError: false });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--allow-file-access-from-files'],
  defaultViewport: { width: 1280, height: 800 },
});

async function drive(label, target, isFile) {
  const page = await suite.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));

  await page.goto(target, { waitUntil: 'load', timeout: 45000 });
  await wait(2500);

  const boot = await page.evaluate(() => ({
    game: !!window.__game,
    state: window.__game ? window.__game.state : null,
    actions: document.querySelectorAll('[data-action]').length,
    hasCanvas: !!document.querySelector('#view'),
  }));
  suite.check(`${label}: game script ran`, boot.game, `state=${boot.state} canvas=${boot.hasCanvas}`);
  suite.check(`${label}: UI actions registered`, boot.actions > 0, `${boot.actions} × [data-action]`);

  if (!boot.game) return;

  // main menu → briefing → loadout → deploy (through the real UI path)
  await page.click('[data-action="screen"][data-screen="briefing"]').catch(() => {});
  await wait(700);
  const brief = await page.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
  suite.check(`${label}: menu navigates to briefing`, brief);

  await page.click('#screen-briefing [data-action="screen"][data-screen="loadout"]').catch(() => {});
  await wait(700);
  await page.evaluate(() => document.querySelector('#btn-deploy') && document.querySelector('#btn-deploy').click());
  await wait(4000);

  const play = await page.evaluate(() => ({
    state: window.__game.state,
    hud: !document.querySelector('#hud').classList.contains('hidden'),
    squad: window.__game.squad ? window.__game.squad.length : 0,
    suspects: window.__game.suspects ? window.__game.suspects.length : 0,
    frames: window.__game.frame || null,
  }));
  suite.check(`${label}: can deploy into the mission`, play.state === 'play', `state=${play.state}`);
  suite.check(`${label}: HUD visible`, play.hud);
  suite.check(`${label}: squad and suspects spawned`, play.squad === 4 && play.suspects > 0,
    `squad=${play.squad} suspects=${play.suspects}`);

  const real = errors.filter((e) => !/favicon/i.test(e));
  suite.check(`${label}: no page errors`, real.length === 0, real.slice(0, 3).join(' | ') || 'none');
  await page.close();
}

await drive('live Pages', URL_, false);

const distPath = join(ROOT, FILE_);
if (existsSync(distPath)) {
  await drive('local dist single file', 'file://' + distPath, true);
} else {
  suite.check('local dist single file exists', false, FILE_ + ' is missing; run node build.mjs first');
}

await suite.finish();
