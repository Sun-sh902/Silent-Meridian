/* ============================================================
   tools/perf-bench.mjs — 低方差的性能基准（可做 A/B 对比）
   ------------------------------------------------------------
   与 perf-probe.mjs 的分工：
     · perf-probe  —— 稳态「成本」画像（每帧 DOM/布局/GPU 资源增量）
     · perf-bench  —— 纯逻辑吞吐与 draw call 计数，方差小，适合前后对比

   为什么要有纯逻辑基准：
     headless + swiftshader 下帧率只有个位数，rAF 帧时间被软件光栅化主导，
     噪声极大，测不出逻辑层的优化。本脚本用 ?test=1 冻结 rAF，
     再用固定步长手动驱动 advance()，于是测到的几乎全是 CPU 逻辑耗时。
     每个场景重复多轮取中位数，进一步压掉抖动。

   用法：
     node tools/perf-bench.mjs                 # 打印结果
     node tools/perf-bench.mjs --json          # 机器可读
     node tools/perf-bench.mjs --save a.json
     node tools/perf-bench.mjs --diff a.json   # 回归则退出码非 0
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Suite, ROOT as root } from './harness.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const saveTo = argv.includes('--save') ? argv[argv.indexOf('--save') + 1] : null;
const diffFrom = argv.includes('--diff') ? argv[argv.indexOf('--diff') + 1] : null;

const STEPS = 900;        // 每个场景的固定步数（15 秒模拟时间）
const ROUNDS = 9;         // 重复轮数
/* 主指标取「最快一轮」而不是中位数：
   CPU 微基准里最小值受系统干扰最小，是更稳的估计量；
   中位数保留在输出里作为参考。实测同一份代码跨进程重跑仍有约 ±15% 漂移，
   因此只有明显大于该幅度的差异才可采信（diff 的容差按此设定）。 */

const suite = new Suite('perf-bench', { failOnPageError: true });
const server = await suite.serve({ port: 8301 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await suite.newPage();
await page.goto('http://127.0.0.1:8301/?deploy=1&test=1&pos=0,-30&yaw=0', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2800));

/* ---------------- 纯逻辑吞吐 ---------------- */
const logic = await page.evaluate(({ STEPS, ROUNDS }) => {
  const g = window.__game;
  const P = g.player;
  const DT = 1 / 60;
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };

  const resetScene = () => {
    g.input.keys.clear();
    g.input.lmb = false; g.input.lmbPressed = false; g.input.rmb = false;
    P.pos.x = 0; P.pos.z = -30; P.yaw = 0; P.pitch = 0;
    P.ads = 0; P.reloading = 0; P.fireCd = 0; P.healthRegen = 0;
    P.hp = P.maxHp; P.alive = true;
    P.mag.primary = 9999; P.reserve.primary = 9999;
    g.squad.forEach((m, i) => { m.pos.x = i * 1.6; m.pos.z = -28; m.path = null; m.alive = true; m.hp = m.maxHp; });
    g.suspects.forEach((s, i) => { s.pos.x = 999 + i; s.pos.z = 999; s.alive = true; });
    g.civilians.forEach((c, i) => { c.pos.x = 999 + i; c.pos.z = 999; });
    g.squadOrder = 'follow'; g.squadWaypoint = null;
    g.alarmRaised = false; g.weaponsFree = false;
  };

  const bench = (label, setup) => {
    /* 先跑一轮不计时，让 JIT 把热路径编译完 */
    resetScene(); setup();
    for (let i = 0; i < STEPS; i++) g.advance(DT, DT);
    const times = [];
    for (let r = 0; r < ROUNDS; r++) {
      resetScene();
      setup();
      const t0 = performance.now();
      for (let i = 0; i < STEPS; i++) g.advance(DT, DT);
      times.push(performance.now() - t0);
    }
    const best = Math.min(...times), m = med(times);
    return { label, ms: +best.toFixed(3), medianMs: +m.toFixed(3),
             usPerStep: +((best * 1000) / STEPS).toFixed(2) };
  };

  const out = [];

  /* A. 静置：小队按队形跟随（最常见的状态） */
  out.push(bench('idle-follow', () => {}));

  /* B. 移动清场：全体沿路径推进 + 交替掩护切换 */
  out.push(bench('clear-order', () => {
    g.squad.forEach((m) => { m.pos.x = 0; m.pos.z = -34; m.path = null; m.pathAge = 2; });
    g.issueClearAt(0, 20);
  }));

  /* C. 交战：9 名嫌疑人全部觉醒并持续开火（感知 + 弹道 + 特效最重的状态） */
  out.push(bench('engage-9', () => {
    g.raiseAlarm('bench');
    g.suspects.forEach((s, i) => {
      s.alive = true; s.hp = s.maxHp; s.morale = 1;
      const a = (i / 9) * Math.PI * 2;
      s.pos.x = Math.cos(a) * 14; s.pos.z = -30 + Math.sin(a) * 14;
      s.awareness = 1; s.alerted = true; s.state = 'engage'; s.target = P;
      s.fireCd = 0; s.burstLeft = 3;
    });
    g.weaponsFree = true;
    g.input.lmb = true;
    P.mag.primary = 9999; P.reserve.primary = 9999;
  }));

  /* D. 小队开火 + 全自动射击（弹道/特效分配最密集的路径） */
  out.push(bench('squad-firing', () => {
    g.weaponsFree = true;
    g.input.lmb = true;
    g.squad.forEach((m, i) => { m.pos.x = i * 1.6 - 3; m.pos.z = -26; m.aimTarget = null; });
    g.suspects.forEach((s, i) => {
      s.alive = true; s.hp = s.maxHp;
      s.pos.x = -6 + i * 1.5; s.pos.z = 6;
      s.awareness = 1; s.alerted = true; s.state = 'engage'; s.target = P;
    });
  }));

  /* HUD 单独计时：advance() 内部会调用 ui.update()，
     而 HUD 的 DOM/布局开销正是本次优化的主战场。
     单独测一遍才能把「HUD 成本」从「游戏逻辑成本」里分出来，否则无法归因。 */
  resetScene();
  for (let i = 0; i < STEPS; i++) g.ui.update(DT, g);      // 预热
  const hudTimes = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < STEPS; i++) g.ui.update(DT, g);
    hudTimes.push(performance.now() - t0);
  }
  const hudMs = Math.min(...hudTimes);
  out.push({ label: 'hud-update-only', ms: +hudMs.toFixed(3), medianMs: +med(hudTimes).toFixed(3),
             usPerStep: +((hudMs * 1000) / STEPS).toFixed(2) });

  return out;
}, { STEPS, ROUNDS });

/* ---------------- draw call / 三角面 ---------------- */
/* 关键：逻辑基准把演员传送到了 999（远超 far=420），若直接接着测渲染，
   几乎整个场景都会被视锥裁掉，draw call 只剩十几 —— 那是空场景的数字。
   这里先重新部署，回到真实任务状态再扫描视角。 */
await page.evaluate(() => {
  const g = window.__game;
  g.input.keys.clear(); g.input.lmb = false; g.input.lmbPressed = false;
  g.testMode = false;
  g.deploy(g.loadout);
});
await new Promise((r) => setTimeout(r, 3000));
const draw = await page.evaluate(async () => {
  const g = window.__game;
  const info = g.renderer.info;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const max = (a) => Math.max(...a);

  /* 陷阱：Game.loop() 每帧调用两次 renderer.render() ——
     先主场景，再 viewmodel 的私有场景。而 info.autoReset 为 true，
     第二次 render() 会把计数清零，于是直接读 info.render.calls 得到的是
     「武器」的 draw call（十几个），完全测不到关卡。
     这里包一层 render，只在主场景那一次之后取样。 */
  const r = g.renderer;
  const origRender = r.render.bind(r);
  let lastMain = { calls: 0, triangles: 0 };
  r.render = function (scene, cam) {
    const out = origRender(scene, cam);
    if (scene === g.scene) lastMain = { calls: info.render.calls, triangles: info.render.triangles };
    return out;
  };

  /* 单个视角会碰巧看不到水洼等物，因此做一次视角扫描：
     逐点传送并在稳定后取样，既看中位数也看峰值。
     峰值对「合并 46 个水洼」这类改动最敏感（原来最多 46 次透明 draw call）。 */
  const VIEWS = [
    [0, -30, 0], [0, -30, Math.PI], [0, 10, Math.PI / 2], [0, 10, -Math.PI / 2],
    [-45, 0, 0.8], [45, 0, -2.3], [0, 40, Math.PI], [-60, -50, 2.6],
  ];
  const calls = [], tris = [];
  for (const [x, z, yaw] of VIEWS) {
    const p = g.player;
    p.pos.x = x; p.pos.z = z; p.yaw = yaw; p.pitch = 0;
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    calls.push(lastMain.calls);
    tris.push(lastMain.triangles);
  }
  r.render = origRender;
  return {
    calls: med(calls), callsMax: max(calls),
    triangles: med(tris), trianglesMax: max(tris),
    views: calls,
    programs: info.programs ? info.programs.length : -1,
    geometries: info.memory.geometries, textures: info.memory.textures,
  };
});

const result = { logic, draw };

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('');
  console.log('===== perf-bench =====');
  console.log('纯逻辑（900 步固定步长，取 7 轮中位数）');
  for (const r of logic) {
    console.log('  ' + r.label.padEnd(16) + r.ms.toFixed(1).padStart(6) + ' ms(最快) / ' +
      r.medianMs.toFixed(1).padStart(6) + ' ms(中位)  ' + String(r.usPerStep).padStart(7) + ' µs/步');
  }
  console.log('渲染');
  console.log('  draw calls  中位 ' + draw.calls + ' / 峰值 ' + draw.callsMax);
  console.log('  triangles   中位 ' + draw.triangles + ' / 峰值 ' + draw.trianglesMax);
  console.log('  各视角 calls ' + JSON.stringify(draw.views));
  console.log('  programs    ' + draw.programs);
  console.log('  geometries  ' + draw.geometries + '   textures ' + draw.textures);
}

if (saveTo) { writeFileSync(saveTo, JSON.stringify(result, null, 2) + '\n', 'utf8'); console.error('[perf-bench] 已保存: ' + saveTo); }

if (diffFrom) {
  if (!existsSync(diffFrom)) { console.error('找不到基准: ' + diffFrom); process.exit(2); }
  const base = JSON.parse(readFileSync(diffFrom, 'utf8'));
  console.log('');
  console.log('===== 与基准对比（越小越好；逻辑耗时的跨进程噪声约 ±15%，容差 25%） =====');
  let regress = 0;
  const row = (name, b, n, tol) => {
    const pct = b ? ((n - b) / b) * 100 : (n === 0 ? 0 : Infinity);
    const worse = n > b * (1 + tol);
    if (worse) regress++;
    console.log((worse ? '[回归] ' : (n < b * (1 - tol) ? '[改善] ' : '[持平] ')) +
      name.padEnd(18) + b + ' -> ' + n + '  (' + (Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : 'n/a') + ')');
  };
  for (const r of result.logic) {
    const b = base.logic.find((x) => x.label === r.label);
    if (b) row('logic:' + r.label, b.ms, r.ms, 0.25);   // 实测跨进程噪声约 ±15%，容差取 25%
  }
  row('draw calls(中位)', base.draw.calls, draw.calls, 0.02);
  row('draw calls(峰值)', base.draw.callsMax, draw.callsMax, 0.02);
  /* 三角形数与 draw call 数是一对权衡：合并网格能减少 draw call，
     但会失去逐对象的视锥裁剪、让三角形数上升。两者不该都按「越小越好」判失败，
     因此三角形只报告、不参与退出码。 */
  {
    const b = base.draw.triangles, n = draw.triangles;
    const pct = b ? ((n - b) / b) * 100 : 0;
    console.log('[info] ' + 'triangles(中位)'.padEnd(18) + b + ' -> ' + n +
      '  (' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)  — 与 draw call 权衡，不计入失败');
  }
  row('geometries', base.draw.geometries, draw.geometries, 0.10);
  row('textures', base.draw.textures, draw.textures, 0.10);
  console.log(regress ? '[RESULT] FAIL（' + regress + ' 项回归）' : '[RESULT] PASS');
  await browser.close(); await server.close();
  process.exit(regress ? 1 : 0);
}

await browser.close();
await server.close();
process.exit(0);
