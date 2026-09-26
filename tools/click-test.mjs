/* ============================================================
   tools/click-test.mjs — 用真实 Chrome 验证界面按钮是否真的可点
   用法： node tools/click-test.mjs
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
  return suite.newPage();   // 页面异常由 Suite 统一收集并计入失败
}

/** 点击并回报命中信息：命中自己才算真的点到了 */
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
  assert(info, '元素不存在：' + sel);
  await page.click(sel);
  return info;
}

/* ============ 场景 A：本地服务器版本，完整用户路径 ============ */
const page = await newPage();
await page.goto('http://127.0.0.1:8199/', { waitUntil: 'load' });
await wait(900);

await step('标题 → 行动简报', async () => {
  const i = await clickInfo(page, '[data-action="screen"][data-screen="briefing"]');
  await wait(300);
  const on = await page.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
  assert(on, `简报未显示（hitSelf=${i.hitSelf} top=${i.top}）`);
  return `hitSelf=${i.hitSelf}`;
});

await step('简报 → 装备配置', async () => {
  const i = await clickInfo(page, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
  await wait(300);
  const on = await page.evaluate(() => !document.querySelector('#screen-loadout').classList.contains('hidden'));
  assert(on, `配装未显示（hitSelf=${i.hitSelf} top=${i.top}）`);
  return `hitSelf=${i.hitSelf}`;
});

await step('配装：点选 VK-12 霰弹枪', async () => {
  const before = await page.evaluate(() => window.__game.screens.loadout.primary);
  await clickInfo(page, '#primary-list .pick[data-id="vk12"]');
  await wait(200);
  const after = await page.evaluate(() => window.__game.screens.loadout.primary);
  assert(after === 'vk12', `选择未生效：${before} → ${after}`);
  return `${before} → ${after}`;
});

await step('配装：点选 烟幕弹', async () => {
  await clickInfo(page, '#gadget-list .pick[data-id="smoke"]');
  await wait(150);
  const g = await page.evaluate(() => window.__game.screens.loadout.gadget);
  assert(g === 'smoke', '器材选择未生效：' + g);
  return g;
});

await step('点「进入港区」部署', async () => {
  await clickInfo(page, '#btn-deploy');
  await wait(1800);
  const st = await page.evaluate(() => ({
    state: window.__game.state,
    hud: !document.querySelector('#hud').classList.contains('hidden'),
  }));
  assert(st.state === 'play', '未进入 play 状态：' + st.state);
  assert(st.hud, 'HUD 未显示');
  return `state=${st.state}`;
});

await step('指针锁定下点击不会穿透到 HUD 按钮', async () => {
  const before = await page.evaluate(() => window.__game.squadOrder);
  const locked = await page.evaluate(() => !!document.pointerLockElement);
  await page.click('#command-bar .cmd[data-order="hold"]');
  await wait(350);
  const after = await page.evaluate(() => window.__game.squadOrder);
  if (locked) {
    // 锁定期间点击被投递给画布，指令不应生效（这正是需要 Alt 的原因）
    assert(after === before, '指针锁定下点击竟然穿透到了 HUD：' + before + ' -> ' + after);
  } else {
    // 浏览器未授予指针锁时，点击应当直接生效
    assert(after === 'hold', '未锁定指针时点击应当生效，实际 ' + after);
  }
  return 'locked=' + locked + '，指令 ' + before + ' -> ' + after;
});

await step('按 Alt 释放鼠标 → 光标模式', async () => {
  await page.keyboard.press('Alt');
  await wait(400);
  const st = await page.evaluate(() => ({
    cursorMode: window.__game.cursorMode,
    locked: !!document.pointerLockElement,
    hint: document.querySelector('#cursor-hint').classList.contains('on'),
  }));
  assert(st.cursorMode, 'Alt 未进入光标模式');
  assert(!st.locked, '指针仍处于锁定状态');
  assert(st.hint, 'HUD 未提示鼠标已释放');
  return `cursorMode=${st.cursorMode} locked=${st.locked}`;
});

for (const [cmd, label] of [['hold', '原地待命'], ['follow', '编队跟随'], ['regroup', '归队'], ['clear', '移动清场']]) {
  await step(`光标模式下点击 HUD 指令【${label}】`, async () => {
    const i = await clickInfo(page, `#command-bar .cmd[data-order="${cmd}"]`);
    await wait(300);
    const order = await page.evaluate(() => window.__game.squadOrder);
    assert(i.hitSelf, `点击被 ${i.top} 拦截（pointer-events:${i.pointerEvents}）`);
    assert(order === cmd, `指令未生效：squadOrder=${order}，期望 ${cmd}`);
    return `squadOrder=${order}`;
  });
}

await step('指令真正下发给每名队员', async () => {
  await clickInfo(page, '#command-bar .cmd[data-order="hold"]');
  await wait(600);
  const states = await page.evaluate(() => window.__game.squad.map((m) => m.lastOrder));
  assert(states.every((s) => s === 'hold'), '队员未收到 hold：' + states.join(','));
  return states.join(',');
});

await step('点击画面 → 恢复鼠标视角（退出光标模式）', async () => {
  await page.mouse.click(720, 300);
  await wait(500);
  const st = await page.evaluate(() => ({ c: window.__game.cursorMode, locked: !!document.pointerLockElement }));
  assert(!st.c, '未退出光标模式');
  return `cursorMode=${st.c} locked=${st.locked}`;
});

await step('Tab 打开战术地图', async () => {
  await page.keyboard.press('Tab');
  await wait(400);
  assert(await page.evaluate(() => window.__game.tacmap.open), '地图未打开');
  const size = await page.evaluate(() => {
    const c = document.querySelector('#tacmap-canvas');
    return `${c.width}x${c.height}`;
  });
  return 'canvas ' + size;
});

await step('战术地图内点击下达航点', async () => {
  const box = await page.$eval('#tacmap-canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.35 };
  });
  await page.mouse.click(box.x, box.y);
  await wait(300);
  const after = await page.evaluate(() => window.__game.squadWaypoint);
  assert(after, '航点未放置');
  return `waypoint=(${after.x.toFixed(1)}, ${after.z.toFixed(1)})`;
});

await step('Tab 关闭战术地图', async () => {
  await page.keyboard.press('Tab');
  await wait(300);
  assert(!(await page.evaluate(() => window.__game.tacmap.open)), '地图未关闭');
});

await step('Esc 暂停 → 点「继续行动」', async () => {
  await page.keyboard.press('Escape');
  await wait(350);
  assert(await page.evaluate(() => !document.querySelector('#screen-pause').classList.contains('hidden')), '暂停界面未显示');
  await clickInfo(page, '#btn-resume');
  await wait(300);
  assert(await page.evaluate(() => window.__game.paused === false), '未能继续');
});

await step('Esc 暂停 → 点「中止并返回主菜单」', async () => {
  await page.keyboard.press('Escape');
  await wait(300);
  await clickInfo(page, '#btn-abort');
  await wait(400);
  const t = await page.evaluate(() => ({
    title: !document.querySelector('#screen-title').classList.contains('hidden'),
    state: window.__game.state,
  }));
  assert(t.title && t.state === 'menu', `未返回主菜单 state=${t.state} title=${t.title}`);
});

await step('主菜单「操作说明」→ 关闭', async () => {
  await clickInfo(page, '#btn-controls');
  await wait(300);
  assert(await page.evaluate(() => !document.querySelector('#screen-help').classList.contains('hidden')), '操作说明未显示');
  await clickInfo(page, '#btn-help-close');
  await wait(250);
  assert(await page.evaluate(() => !document.querySelector('#screen-title').classList.contains('hidden')), '关闭后未回到标题');
});

/* ============ 场景 B：单文件构建（file://） ============ */
const distPath = join(root, 'dist', 'silent-meridian.html');
if (existsSync(distPath)) {
  const p2 = await newPage();
  await p2.goto('file://' + distPath, { waitUntil: 'load' });
  await wait(1200);
  await step('单文件版：标题 → 简报', async () => {
    const i = await clickInfo(p2, '[data-action="screen"][data-screen="briefing"]');
    await wait(300);
    const on = await p2.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
    assert(on, `简报未显示（hitSelf=${i.hitSelf} top=${i.top}）`);
    return `hitSelf=${i.hitSelf}`;
  });
  await step('单文件版：配装 → 部署 → 指令按钮', async () => {
    await clickInfo(p2, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
    await wait(250);
    await clickInfo(p2, '#btn-deploy');
    await wait(1800);
    assert(await p2.evaluate(() => window.__game.state === 'play'), '未进入行动');
    await p2.keyboard.press('Alt');          // 释放鼠标后才能点击 HUD
    await wait(350);
    assert(await p2.evaluate(() => window.__game.cursorMode), 'Alt 未进入光标模式');
    await clickInfo(p2, '#command-bar .cmd[data-order="hold"]');
    await wait(300);
    const order = await p2.evaluate(() => window.__game.squadOrder);
    assert(order === 'hold', '指令未生效：' + order);
    return 'squadOrder=' + order;
  });
  await p2.close();
} else {
  suite.check('单文件版测试', false, '缺少 dist/silent-meridian.html，请先 node build.mjs');
}

/* ============ 场景 C：index.html 直接用 file:// 打开（用户报错的那条路径） ============ */
const indexPath = join(root, 'index.html');
{
  const p3 = await newPage();
  await p3.goto('file://' + indexPath, { waitUntil: 'load' });
  await wait(2600);
  await step('file:// 打开 index.html：主脚本确实执行', async () => {
    const d = await p3.evaluate(() => window.__SM_DEBUG && {
      booted: window.__SM_DEBUG.booted,
      loader: window.__SM_DEBUG.loader,
      mainLoaded: window.__SM_DEBUG.mainLoaded,
      mainError: window.__SM_DEBUG.mainError,
      handlerReady: window.__SM_DEBUG.handlerReady,
      errorVisible: !document.querySelector('#boot-error').classList.contains('hidden'),
    });
    assert(d, 'window.__SM_DEBUG 不存在 —— 引导脚本都没跑');
    assert(d.mainLoaded, `主脚本未加载（loader=${d.loader} err=${d.mainError} 提示可见=${d.errorVisible}）`);
    assert(d.handlerReady, '动作处理器未注册');
    return `loader=${d.loader}`;
  });
  await step('file:// 打开 index.html：标题按钮可点', async () => {
    const i = await clickInfo(p3, '[data-action="screen"][data-screen="briefing"]');
    await wait(300);
    const on = await p3.evaluate(() => !document.querySelector('#screen-briefing').classList.contains('hidden'));
    assert(on, `简报未显示（hitSelf=${i.hitSelf} top=${i.top}）`);
    return `hitSelf=${i.hitSelf}`;
  });
  await step('file:// 打开 index.html：部署后指令按钮可点', async () => {
    await clickInfo(p3, '#screen-briefing [data-action="screen"][data-screen="loadout"]');
    await wait(250);
    await clickInfo(p3, '#btn-deploy');
    await wait(1800);
    assert(await p3.evaluate(() => window.__game.state === 'play'), '未进入行动');
    await p3.keyboard.press('Alt');
    await wait(350);
    await clickInfo(p3, '#command-bar .cmd[data-order="hold"]');
    await wait(300);
    const order = await p3.evaluate(() => window.__game.squadOrder);
    assert(order === 'hold', '指令未生效：' + order);
    return 'squadOrder=' + order;
  });
  await step('按 D 唤出调试面板并显示最近点击', async () => {
    // 先回到菜单，指针未锁定时按 D
    await p3.evaluate(() => { if (document.exitPointerLock) document.exitPointerLock(); });
    await wait(300);
    /* P0-3 的回归守卫：行动中 D 属于游戏（右平移），不得开关面板 */
  await p3.keyboard.press('KeyD');
  await wait(250);
  const dOpened = await p3.evaluate(() => {
    const p = document.querySelector('#debug-panel');
    return p ? !p.classList.contains('hidden') : false;
  });
  assert(!dOpened, '行动中按 D 不应弹出调试面板（P0-3 回归）');
  /* 行动中请用 ~ 唤出面板 */
  await p3.keyboard.press('Backquote');
    await wait(300);
    const d = await p3.evaluate(() => {
      const p = document.querySelector('#debug-panel');
      return { visible: p && !p.classList.contains('hidden'), text: p ? p.innerText : '' };
    });
    assert(d.visible, '调试面板未显示');
    assert(/脚本已执行/.test(d.text), '面板缺少“脚本已执行”');
    assert(/已加载/.test(d.text), '面板未显示主脚本已加载');
    assert(/#command-bar|action=order|order/.test(d.text), '面板未记录点击事件');
    return d.text.split('\n').slice(0, 5).join(' | ');
  });
  await p3.close();
}

await suite.finish();
