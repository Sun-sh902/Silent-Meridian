/* ============================================================
   tools/audio-stress.mjs — 闪光弹压力测试（验收用）
   连续触发 20 次闪光弹，检查：
     · 引爆次数是否恰好 20（防止“每帧重复引爆”回归）
     · 主线程逻辑耗时（不含渲染）是否稳定
     · AudioContext 数量是否恒为 1
     · 音频节点 / 投掷物 / DOM 日志是否回收
     · 是否出现未捕获异常
   用法： node tools/audio-stress.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('audio-stress');
const server = await suite.serve({ port: 8201 });

const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--js-flags=--expose-gc'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await suite.newPage();
/* 本套件额外把「单帧逻辑耗时异常」这类 warning 也算作失败 */
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'warning' && /SILENT MERIDIAN/.test(t)) suite.pageErrors.push('warn: ' + t);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = suite.results;
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8201/?deploy=1&pos=0,-30&yaw=0', { waitUntil: 'load' });
await wait(2500);

// 基线
const base = await page.evaluate(() => ({
  audio: window.__game.audio.stats(),
  nodes: window.__game.actors.length,
  domNodes: document.getElementsByTagName('*').length,
  heap: performance.memory ? performance.memory.usedJSHeapSize : null,
}));
check('AudioContext 仅有 1 个', base.audio.ctxCount === 1, 'ctxCount=' + base.audio.ctxCount);
check('噪声缓冲已就绪', base.audio.noiseReady, 'noiseReady=' + base.audio.noiseReady);

// 对照组：不触发任何投掷物，采集同样的帧数量，作为“环境基线”
await page.evaluate(() => {
  const p = window.__game.perf;
  p.logicMax = 0; p.logicSum = 0; p.frames = 0; p.stalls = 0; p.worstGap = 0;
});
for (let i = 0; i < 60; i++) {
  await wait(200);
  if (await page.evaluate(() => window.__game.perf.frames) >= 40) break;
}
const control = await page.evaluate(() => ({ ...window.__game.perf }));

// 重置性能计时，开始连续触发 20 次闪光弹
await page.evaluate(() => {
  const g = window.__game;
  g.perf.logicMax = 0; g.perf.logicSum = 0; g.perf.frames = 0; g.perf.stalls = 0; g.perf.worstGap = 0;
  g.player.gadgetDef = Object.assign({}, g.player.gadgetDef, { id: 'flash', fuse: 1.5, radius: 13 });
  g.player.gadgetCount = 40;
  for (let i = 0; i < 20; i++) {
    setTimeout(() => g.player.throwGadget(1), i * 130);
  }
});

// 等到全部引爆并且场上没有残留投掷物
let settled = false;
for (let i = 0; i < 120; i++) {
  await wait(500);
  const s = await page.evaluate(() => ({
    det: window.__game.stats.detonations,
    proj: window.__game.projectiles.length,
    thrown: window.__game.stats.gadgets,
  }));
  if (s.thrown >= 20 && s.det >= 20 && s.proj === 0) { settled = true; break; }
}
await wait(2500);   // 让尾音结束、节点回收

const after = await page.evaluate(() => ({
  det: window.__game.stats.detonations,
  thrown: window.__game.stats.gadgets,
  proj: window.__game.projectiles.length,
  perf: { ...window.__game.perf },
  audio: window.__game.audio.stats(),
  domNodes: document.getElementsByTagName('*').length,
  logItems: document.querySelectorAll('.log-item').length,
  whiteout: getComputedStyle(document.getElementById('whiteout')).opacity,
  heap: performance.memory ? performance.memory.usedJSHeapSize : null,
}));

check('20 次投掷全部引爆', after.thrown >= 20 && after.det >= 20, `投掷=${after.thrown} 引爆=${after.det}`);
check('引爆次数没有爆炸式增长（无每帧重复触发）', after.det <= 21, '引爆=' + after.det + '（期望 <=21）');
check('场上无残留投掷物', after.proj === 0, 'projectiles=' + after.proj);
check('主线程单帧逻辑耗时峰值 < 50ms', after.perf.logicMax < 50,
  `logicMax=${after.perf.logicMax.toFixed(1)}ms avg=${after.perf.logicAvg.toFixed(2)}ms frames=${after.perf.frames}`);
check('主线程平均逻辑耗时 < 16ms', after.perf.logicAvg < 16, `avg=${after.perf.logicAvg.toFixed(2)}ms`);
check('闪光弹未增加每帧逻辑开销（对比对照组）',
  after.perf.logicAvg - control.logicAvg < 3,
  `对照组 ${control.logicAvg.toFixed(2)}ms → 压力组 ${after.perf.logicAvg.toFixed(2)}ms`);
check('AudioContext 仍为 1 个', after.audio.ctxCount === 1, 'ctxCount=' + after.audio.ctxCount);
check('音频节点已回收（不超过 40）', after.audio.liveNodes <= 40, 'liveNodes=' + after.audio.liveNodes);
check('DOM 日志未堆积', after.logItems <= 7, 'log-item=' + after.logItems);
check('白屏叠加层已淡出', parseFloat(after.whiteout) === 0, 'opacity=' + after.whiteout);
/* 页面异常不再是普通断言，而是由 Suite 统一计入失败（更强约束） */
if (base.heap && after.heap) {
  const growMB = (after.heap - base.heap) / 1048576;
  check('JS 堆增长 < 25MB（仅供参考）', growMB < 25, growMB.toFixed(1) + ' MB');
}

console.log('\n===== 闪光弹压力测试（连续 20 次） =====');
for (const r of results) console.log(`${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
console.log('\n阶段统计：');
console.log('  触发期间帧数        :', after.perf.frames);
console.log('  逻辑耗时 平均/峰值  :', after.perf.logicAvg.toFixed(2), '/', after.perf.logicMax.toFixed(1), 'ms');
console.log('  最长帧间隔(含渲染)  :', after.perf.worstGap.toFixed(0), 'ms（软件渲染环境，仅供参考）');
console.log('  对照组(不投掷)      : 每帧逻辑', control.logicAvg.toFixed(2), 'ms · 峰值', control.logicMax.toFixed(1), 'ms · 帧数', control.frames);
console.log('  → 每帧逻辑增量      :', (after.perf.logicAvg - control.logicAvg).toFixed(2), 'ms（这才是环境无关的可信指标）');
console.log('  （帧间隔受软件渲染影响波动极大，本次对照', control.worstGap.toFixed(0), 'ms vs 压力', after.perf.worstGap.toFixed(0), 'ms，不作结论）');
console.log('  被抑制的重复音效    :', after.audio.gated, '次');
console.log('  在用音频节点        :', base.audio.liveNodes, '→', after.audio.liveNodes);
console.log('  DOM 节点            :', base.domNodes, '→', after.domNodes);
if (base.heap && after.heap) console.log('  JS 堆               :', (base.heap / 1048576).toFixed(1), '→', (after.heap / 1048576).toFixed(1), 'MB');
await suite.finish();
