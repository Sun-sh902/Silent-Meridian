/* ============================================================
   tools/perf-probe.mjs — 性能与资源回归探测
   ------------------------------------------------------------
   这不是「通过/失败」型测试，而是**可比较的量化基线**：
   输出每帧 DOM 变更数、布局读取数、逻辑耗时，以及反复部署时的
   GPU 资源增量。用它来证明优化真的有效，而不是凭感觉。

   用法：
     node tools/perf-probe.mjs               # 打印当前指标
     node tools/perf-probe.mjs --json        # 机器可读，便于前后对比
     node tools/perf-probe.mjs --save a.json # 存为基准
     node tools/perf-probe.mjs --diff a.json # 与基准比较（回归则退出码非 0）
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Suite } from './harness.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const saveIdx = argv.indexOf('--save');
const diffIdx = argv.indexOf('--diff');
const saveTo = saveIdx >= 0 ? argv[saveIdx + 1] : null;
const diffFrom = diffIdx >= 0 ? argv[diffIdx + 1] : null;

const suite = new Suite('perf-probe', { failOnPageError: true });
const server = await suite.serve({ port: 8251 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await suite.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto('http://127.0.0.1:8251/?deploy=1&pos=0,-30&yaw=0', { waitUntil: 'load' });
await wait(2800);

/* ---------------- 每帧 DOM / 布局计量 ---------------- */
await page.evaluate(() => {
  const g = window.__game;
  g.testMode = false;                 // 必须走真实主循环，否则量不到每帧开销
  const m = window.__perf = {
    frames: 0, domRecords: 0, layoutReads: 0,
    domByType: { childList: 0, attributes: 0, characterData: 0 },
  };

  /* DOM 变更：观察 #hud 整棵子树 */
  const hud = document.getElementById('hud');
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      m.domRecords++;
      m.domByType[r.type] = (m.domByType[r.type] || 0) + 1;
    }
  });
  mo.observe(hud, { childList: true, subtree: true, attributes: true, characterData: true });
  m._mo = mo;

  /* 布局读取：拦截 clientWidth / clientHeight / getBoundingClientRect 的 getter */
  const count = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get() { m.layoutReads++; return d.get.call(this); },
    });
  };
  count(Element.prototype, 'clientWidth');
  count(Element.prototype, 'clientHeight');
  const gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...a) { m.layoutReads++; return gbcr.apply(this, a); };

  /* 帧计数 */
  const tick = () => { m.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await wait(7000);

const perFrame = await page.evaluate(() => {
  const m = window.__perf, g = window.__game;
  const f = Math.max(1, m.frames);
  m._mo.disconnect();
  return {
    frames: m.frames,
    domPerFrame: +(m.domRecords / f).toFixed(2),
    layoutReadsPerFrame: +(m.layoutReads / f).toFixed(2),
    domByType: m.domByType,
    logicAvgMs: +g.perf.logicAvg.toFixed(2),
    logicMaxMs: +g.perf.logicMax.toFixed(2),
    fps: +g.perf.fps.toFixed(1),
  };
});

/* ---------------- GPU 资源：反复部署的增量 ---------------- */
const gpu = await page.evaluate(async () => {
  const g = window.__game;
  const info = g.renderer.info;
  const snap = () => ({
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : -1,
  });
  /* 逐次部署后快照：用「相邻两次的差」衡量稳态泄漏，
     避免把首次部署的一次性初始化误算成每次泄漏。 */
  const series = [snap()];
  for (let i = 0; i < 5; i++) {
    g.deploy(g.loadout);
    await new Promise((r) => setTimeout(r, 350));
    series.push(snap());
  }
  const steps = [];
  for (let i = 1; i < series.length; i++) {
    steps.push({
      dg: series[i].geometries - series[i - 1].geometries,
      dt: series[i].textures - series[i - 1].textures,
      dp: series[i].programs - series[i - 1].programs,
    });
  }
  const tail = steps.slice(2);            // 丢掉前两次（仍含惰性初始化）
  const avg = (k) => tail.length ? +(tail.reduce((s, x) => s + x[k], 0) / tail.length).toFixed(1) : 0;
  const before = series[0], after = series[series.length - 1];
  return {
    before, after, series, steps,
    dGeometries: after.geometries - before.geometries,
    dTextures: after.textures - before.textures,
    dPrograms: after.programs - before.programs,
    perDeploy: { geometries: avg('dg'), textures: avg('dt') },
  };
});

/* ---------------- WebGL 资源对象计数（framebuffer 等） ---------------- */
const glCounts = await page.evaluate(() => {
  const g = window.__game;
  const gl = g.renderer.getContext();
  const counts = { framebuffers: 0, textures: 0, buffers: 0 };
  const patch = (name, key) => {
    const orig = gl[name].bind(gl);
    // 只统计「创建」；删除由 deleteX 计数
    gl[name] = function (...a) { counts[key]++; return orig(...a); };
  };
  let deleted = 0;
  const origDel = gl.deleteFramebuffer.bind(gl);
  gl.deleteFramebuffer = function (...a) { deleted++; return origDel(...a); };
  patch('createFramebuffer', 'framebuffers');
  const t0 = { ...counts };
  for (let i = 0; i < 3; i++) g.deploy(g.loadout);
  return { created: counts.framebuffers - t0.framebuffers, deleted, over3Deploys: counts.framebuffers };
});

const result = { perFrame, gpu, glCounts };

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('');
  console.log('===== perf-probe =====');
  console.log('每帧 DOM 变更        : ' + perFrame.domPerFrame + ' 条  ' + JSON.stringify(perFrame.domByType));
  console.log('每帧布局读取        : ' + perFrame.layoutReadsPerFrame + ' 次');
  console.log('逻辑耗时 平均/峰值  : ' + perFrame.logicAvgMs + ' / ' + perFrame.logicMaxMs + ' ms');
  console.log('采样帧数            : ' + perFrame.frames);
  console.log('5 次部署的 GPU 增量 : geometries ' + gpu.dGeometries +
    ' / textures ' + gpu.dTextures + ' / programs ' + gpu.dPrograms);
  console.log('  稳态每次部署(后3次): ' + JSON.stringify(gpu.perDeploy));
  console.log('  逐次增量[geo,tex]   : ' + JSON.stringify(gpu.steps.map(x=>[x.dg,x.dt])));
  console.log('  绝对[geo,tex]序列   : ' + JSON.stringify(gpu.series.map(x=>[x.geometries,x.textures])));
  console.log('3 次部署新建/删除 FBO: ' + glCounts.created + ' / ' + glCounts.deleted);
}

if (saveTo) {
  writeFileSync(saveTo, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.error('[perf-probe] 已保存基准: ' + saveTo);
}

if (diffFrom) {
  if (!existsSync(diffFrom)) {
    console.error('[perf-probe] 找不到基准文件: ' + diffFrom);
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(diffFrom, 'utf8'));
  /* 每项都要说明「哪个方向更好」：FBO 删除数是越多越好，其余越少越好。
     逻辑耗时在 swiftshader 下噪声很大（采样帧数少），给更宽的容差。 */
  const rows = [
    ['每帧 DOM 变更', base.perFrame.domPerFrame, perFrame.domPerFrame, 'lower', 0.10],
    ['每帧布局读取', base.perFrame.layoutReadsPerFrame, perFrame.layoutReadsPerFrame, 'lower', 0.10],
    ['部署增量 geometries', base.gpu.perDeploy.geometries, gpu.perDeploy.geometries, 'lower', 0.10],
    ['部署增量 textures', base.gpu.perDeploy.textures, gpu.perDeploy.textures, 'lower', 0.10],
    ['3 次部署新建 FBO', base.glCounts.created, glCounts.created, 'lower', 0.10],
    ['3 次部署删除 FBO', base.glCounts.deleted, glCounts.deleted, 'higher', 0.10],
    ['逻辑耗时(平均, 仅供参考)', base.perFrame.logicAvgMs, perFrame.logicAvgMs, 'lower', 0.60],
  ];
  console.log('');
  console.log('===== 与基准对比 =====');
  let regress = 0;
  for (const [name, b, n, better, tol] of rows) {
    const delta = n - b;
    const pct = b !== 0 ? (delta / Math.abs(b)) * 100 : (n === 0 ? 0 : Infinity);
    const worse = better === 'lower' ? (n > b * (1 + tol) + 1e-9) : (n < b * (1 - tol) - 1e-9);
    const improved = better === 'lower' ? (n < b * (1 - tol)) : (n > b * (1 + tol));
    if (worse && !name.includes('仅供参考')) regress++;
    const tag = worse ? '[回归]' : (improved ? '[改善]' : '[持平]');
    console.log(tag + ' ' + name.padEnd(24) + b + ' -> ' + n +
      '  (' + (Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : 'n/a') + ')');
  }
  console.log(regress ? '[RESULT] FAIL（' + regress + ' 项回归）' : '[RESULT] PASS');
  await browser.close();
  await server.close();
  process.exit(regress ? 1 : 0);
}

await browser.close();
await server.close();
process.exit(0);
