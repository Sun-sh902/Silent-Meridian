/* ============================================================
   tools/p0-test.mjs — 4 个 P0 的复现与回归
   ------------------------------------------------------------
   P0-1 移动清场：队员到位时调用未定义的 g.onElementArrived
   P0-2 SEMI/PUMP/REVOLVER 打不出子弹（lmbHeld 提前置位）
   P0-3 D 键被调试面板在捕获阶段吞掉，Alt 光标模式下无法右平移
   P0-4 暂停→中止→重新部署后 paused 未复位，新一局冻结
   用法： node tools/p0-test.mjs
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

/* ---------------- P0-1 移动清场：连下 3 次并等队员到位 ---------------- */
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
      g.issueClearAt(0, -4 - n * 3);          // 航点很近，保证「到位」必然发生
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
  g.testMode = false;
  return { err, steps, orders, stoppedAt };
});
check('P0-1 连下 3 次「移动清场」并推进到队员到位，不抛异常',
  t1.err === null,
  t1.err ? ('抛异常于第 ' + t1.stoppedAt + ' 步: ' + t1.err) : ('推进 ' + t1.steps + ' 步无异常'));
check('P0-1 模拟未被异常中断（推进步数应为 720）', t1.steps === 720,
  'steps=' + t1.steps + '（被中断时为 ' + t1.stoppedAt + '）');

/* ---------------- P0-2 非 AUTO 模式开火（走真实鼠标事件） ---------------- */
/* 关键：必须通过真实 mousedown 触发 canvas 处理器来置「按下沿」信号，
   直接改 g.input.lmb 会绕过输入链路，测不出 P0-2 这类缺陷。 */
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
  /* 在 canvas 上派发真实 MouseEvent：走的是同一个 addEventListener 处理器，
     但不受 Puppeteer 鼠标状态机影响，可重复执行。 */
  await page.evaluate(() => {
    document.getElementById('view')
      .dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  });
  const fired = await page.evaluate(() => {
    const g = window.__game;
    const before = g.stats.shots;
    g.advance(1 / 60, 1 / 60);                   // 固定步长推进一帧
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
check('P0-2 默认副武器 P9（SEMI）能打出子弹',
  t2.sidearmReal.fired >= 1,
  'mode=' + t2.sidearmReal.mode + '，一次真实点击发数=' + t2.sidearmReal.fired);
check('P0-2 AUTO 模式能打出子弹', t2.AUTO >= 1, '发数=' + t2.AUTO);
check('P0-2 SEMI 模式能打出子弹', t2.SEMI >= 1, '发数=' + t2.SEMI);
check('P0-2 PUMP 模式能打出子弹', t2.PUMP >= 1, '发数=' + t2.PUMP);
check('P0-2 REVOLVER 模式能打出子弹', t2.REVOLVER >= 1, '发数=' + t2.REVOLVER);

/* ---------------- P0-3 D 键与调试面板 ---------------- */
await page.evaluate(() => {
  const g = window.__game;
  g.testMode = true;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0; g.player.pitch = 0; g.player.ads = 0;
  g.setCursorMode(true);                       // 等价于按 Alt 释放鼠标
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
    panelOpen: dbg ? !dbg.classList.contains('hidden') : false,   // 元素不存在 = 未弹出
  };
  g.input.keys.clear();
  g.setCursorMode(false);
  g.testMode = false;
  return res;
});
await page.keyboard.up('KeyD');
await wait(150);
check('P0-3 Alt 光标模式下 D 能右平移', t3.movedX > 0.5,
  'x 位移=' + t3.movedX + 'm，按键被游戏接收=' + t3.keySeen);
check('P0-3 Alt 光标模式下 D 不弹出调试面板', t3.panelOpen === false, 'panelOpen=' + t3.panelOpen);

/* ---------------- P0-4 暂停→中止→重新部署 ---------------- */
/* 先取 paused 标志，再用「真实 rAF 主循环」验证是否冻结
   —— 直接调 advance() 会绕过 loop() 里的 ts=0，测不出冻结 */
const t4a = await page.evaluate(() => {
  const g = window.__game;
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
await wait(1400);   // 让真实主循环跑一段（若 paused 未复位，dt 恒为 0）
const t4 = await page.evaluate(() => {
  const g = window.__game;
  const moved = +Math.abs(g.player.pos.z - window.__z0).toFixed(3);
  g.input.keys.clear();
  return { moved, pausedNow: g.paused };
});
check('P0-4 暂停后 paused=true（前置条件成立）', t4a.afterPause === true, 'paused=' + t4a.afterPause);
check('P0-4 中止→重新部署后 paused 已复位', t4a.afterDeploy === false, 'paused=' + t4a.afterDeploy);
check('P0-4 新一局能正常推进（非冻结，走真实主循环）', t4.moved > 0.2,
  '1.4 秒真实位移=' + t4.moved + 'm，当前 paused=' + t4.pausedNow);

await suite.finish();
