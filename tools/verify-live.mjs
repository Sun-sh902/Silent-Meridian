/* ============================================================
   tools/verify-live.mjs — 验证「线上 Pages 站点」与「本地 dist 单文件」都能真跑
   ------------------------------------------------------------
   用法： node tools/verify-live.mjs [--url https://...] [--file dist/silent-meridian.html]

   这不是常规回归套件（它依赖外网），是一次性的发布验收：
     1) 打开线上 Pages 站点 → 断言游戏脚本执行、动作注册、能点到简报、能真的部署进港区
     2) 打开本地 dist/ 单文件（file://）→ 断言同样能跑，证明 clone 后双击可用
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
  suite.check(`${label}：游戏脚本执行`, boot.game, `state=${boot.state} canvas=${boot.hasCanvas}`);
  suite.check(`${label}：界面动作已注册`, boot.actions > 0, `${boot.actions} 个 [data-action]`);

  if (!boot.game) return;

  // 主菜单 → 简报 → 配装 → 部署（走真实界面路径）
  await page.click('[data-action="screen"][data-screen="briefing"]').catch(() => {});
  await wait(700);
  const brief = await page.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
  suite.check(`${label}：菜单可导航到简报`, brief);

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
  suite.check(`${label}：能部署进入行动`, play.state === 'play', `state=${play.state}`);
  suite.check(`${label}：HUD 显示`, play.hud);
  suite.check(`${label}：小队与嫌疑人已生成`, play.squad === 4 && play.suspects > 0,
    `squad=${play.squad} suspects=${play.suspects}`);

  const real = errors.filter((e) => !/favicon/i.test(e));
  suite.check(`${label}：页面无异常`, real.length === 0, real.slice(0, 3).join(' | ') || '无');
  await page.close();
}

await drive('线上 Pages', URL_, false);

const distPath = join(ROOT, FILE_);
if (existsSync(distPath)) {
  await drive('本地 dist 单文件', 'file://' + distPath, true);
} else {
  suite.check('本地 dist 单文件存在', false, FILE_ + ' 不存在，先跑 node build.mjs');
}

await suite.finish();
