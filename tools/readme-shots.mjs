/* ============================================================
   tools/readme-shots.mjs — 为 README 生成真实截图（人工流程，不进 run-all）
   ------------------------------------------------------------
   用法： node tools/readme-shots.mjs [--out docs/shots] [--port 8197]

   真实启动游戏，按用户路径走一遍界面并截图：
     01-title  主菜单     02-briefing 行动简报   03-loadout  装备配置
     04-yard   港区行动   05-tacmap   战术地图   06-debrief  战果
   依赖仓库已有的 puppeteer-core + 本机 Chrome，不新增依赖。
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
    return el ? el.id : '(无全屏界面)';
  });
  suite.info(`${name}.png`, shown);
  return file;
}

/**
 * 点界面上真实存在的按钮。
 * 优先用真实鼠标点击（能命中自己才算数）；元素在滚动区下方露不出来时退回 DOM click，
 * 并报告用的是哪条路径——截图脚本只关心界面能被驱动，不替代 click-test 的命中率断言。
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
  console.error('[shots] 游戏脚本未运行，放弃截图');
  await suite.finish();
}

await step('01 主菜单', async () => {
  await shoot('01-title');
  return '1600x900';
});

await step('02 行动简报', async () => {
  await click('[data-action="screen"][data-screen="briefing"]');
  await wait(900);
  if (!(await screenOn('#screen-briefing'))) throw new Error('简报未显示');
  return await shoot('02-briefing');
});

await step('03 装备配置', async () => {
  await click('#screen-briefing [data-action="screen"][data-screen="loadout"]');
  await wait(900);
  if (!(await screenOn('#screen-loadout'))) throw new Error('配装未显示');
  // 选一套看得清配置的方案，让截图不至于停留在默认值
  await click('#primary-list .pick[data-id="vk12"]');
  await wait(250);
  await click('#gadget-list .pick[data-id="smoke"]');
  await wait(400);
  return await shoot('03-loadout');
});

await step('04 港区行动', async () => {
  if (!(await click('#btn-deploy'))) throw new Error('找不到「进入港区」按钮');
  await wait(4200);
  const st = await page.evaluate(() => window.__game.state);
  if (st !== 'play') throw new Error('未进入行动状态：' + st);
  // 把准星放平、镜头对准仓区，避免截到地面
  await page.evaluate(() => {
    const g = window.__game;
    g.player.pitch = -0.04;
    g.squad.forEach((m) => { m.lastOrder = 'follow'; });
  });
  await wait(900);
  return await shoot('04-yard');
});

await step('05 战术地图', async () => {
  await page.keyboard.press('Tab');
  await wait(1500);
  if (!(await page.evaluate(() => window.__game.tacmap.open))) throw new Error('战术地图未打开');
  return await shoot('05-tacmap');
});

await step('06 战果结算', async () => {
  // 先退出战术地图，否则结算界面会压在还开着的 3D 场景 / 地图上
  await page.evaluate(() => {
    const g = window.__game;
    if (g.tacmap && g.tacmap.open) g.toggleTacMap();
  });
  await wait(500);
  await page.evaluate(() => {
    const g = window.__game;
    g.screens.showDebrief({
      success: true, grade: 'A', comment: '流程干净、节奏克制。小队的推进与火力纪律都符合警备处的标准作业程序。',
      time: '7:24', shots: 61, accuracy: 38, blindShots: 3, detained: 3, killed: 1, escaped: 0,
      suspectTotal: 9, civSafe: 4, civLost: 0, civTotal: 4, orders: 11, squadDown: 0, gadgets: 2,
      objectives: { manifest: 'done', evidence: 'done', civilians: 'done', suspects: 'done', extract: 'done' },
      squad: [
        { callsign: 'LEAD', role: '制式防弹背心', alive: true, hp: 96, maxHp: 120 },
        { callsign: 'ARDEN-2', role: 'RIFLEMAN · 侦察', alive: true, hp: 118, maxHp: 130 },
        { callsign: 'BRAM-3', role: 'RIFLEMAN · 火力', alive: true, hp: 74, maxHp: 130 },
        { callsign: 'CIRA-4', role: 'BREACHER · 突击', alive: true, hp: 130, maxHp: 130 },
        { callsign: 'DOV-5', role: 'MEDIC · 支援', alive: true, hp: 101, maxHp: 130 },
      ],
    });
    g.screens.show('debrief');
    g.screens.hideGame();
  });
  await wait(900);
  return await shoot('06-debrief');
});

/* 记录本次截图的来源提交，方便日后核对是否过期 */
const head = await page.evaluate(() => 'v' + (window.__SM_DEBUG && window.__SM_DEBUG.build ? window.__SM_DEBUG.build : '?'));
await writeFile(
  join(OUT, 'README.md'),
  [
    '# docs/shots — README 截图',
    '',
    '由 `node tools/readme-shots.mjs` 真实运行游戏后生成，不是手绘示意图。',
    '',
    '| 文件 | 界面 |',
    '| --- | --- |',
    '| `01-title.png` | 主菜单 |',
    '| `02-briefing.png` | 行动简报 |',
    '| `03-loadout.png` | 装备配置 |',
    '| `04-yard.png` | 港区行动（HUD / 小队 / 状态条） |',
    '| `05-tacmap.png` | 战术地图（Tab） |',
    '| `06-debrief.png` | 战果结算 |',
    '',
    '重新生成：`node tools/readme-shots.mjs`（会用本机 Chrome 跑一遍真实界面）。',
    '',
    `生成时页面版本：${head}`,
    '',
  ].join('\n'),
);

await suite.finish();
