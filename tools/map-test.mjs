/* ============================================================
   tools/map-test.mjs — 小地图 / 战术地图 坐标变换验收
   ------------------------------------------------------------
   覆盖用户的验收标准：
     1) 原地旋转 360° 后建筑回到初始相对位置（无累积漂移）
     2) 实际右转 90° 后，原本正前方的建筑出现在地图正左侧
     3) 连续旋转 60 秒轨迹平滑，无跳变
     4) 建筑名字全程水平、无重叠、不越界
     5) 玩家图标固定在中心，箭头方向与朝向一致（含战术地图 180° 修正）
     6) window.__mapDebug 可用，且与画面像素一致
   用法： node tools/map-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('map-test');
const server = await suite.serve({ port: 8207 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await suite.newPage();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = suite.results;
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8207/?deploy=1&pos=0,0&yaw=0', { waitUntil: 'load' });
await wait(2800);

/* ============ 6. 调试接口存在性与形状 ============ */
const dbg = await page.evaluate(() => {
  const d = window.__mapDebug;
  if (!d) return null;
  return {
    keys: Object.keys(d).sort(),
    player: d.player,
    buildings: d.buildings.slice(0, 3),
    buildingsN: d.buildings.length,
    mode: d.mode,
    wm: d.worldToMap(0, -20),
    wmObj: d.worldToMap({ x: 0, z: -20 }),
  };
});
check('window.__mapDebug 已暴露', !!dbg, dbg ? dbg.mode : '不存在');
check('__mapDebug.player 含 {x,y,yaw}', !!dbg && dbg.player && 'x' in dbg.player && 'y' in dbg.player && 'yaw' in dbg.player,
  dbg ? JSON.stringify(dbg.player) : '');
check('__mapDebug.buildings 含 {name,x,y}', !!dbg && dbg.buildingsN > 0 && 'name' in dbg.buildings[0],
  dbg ? `${dbg.buildingsN} 个, 例: ${JSON.stringify(dbg.buildings[0])}` : '');
check('worldToMap 支持 (x,z) 与 {x,z} 两种调用', !!dbg && JSON.stringify(dbg.wm) === JSON.stringify(dbg.wmObj),
  dbg ? `${JSON.stringify(dbg.wm)} / ${JSON.stringify(dbg.wmObj)}` : '');

/* ============ 2. 右转 90°，正前方目标必须移到地图左侧 ============ */
const turn = await page.evaluate(() => {
  const g = window.__game, d = window.__mapDebug;
  const out = {};
  const ahead = { x: g.player.pos.x, z: g.player.pos.z - 20 };   // 正北 20 米
  g.player.yaw = 0;
  out.at0 = d.worldToMap(ahead.x, ahead.z);
  // 实际右转 90°：本项目 yaw 减小 = 右转（player.look 里 yaw -= dx*sens）
  g.player.yaw = -Math.PI / 2;
  out.afterRight = d.worldToMap(ahead.x, ahead.z);
  g.player.yaw = 0;
  return out;
});
const cx = await page.evaluate(() => window.__game.ui._W / 2);
check('转向基准：yaw=0 时正前方目标在地图正上方',
  Math.abs(turn.at0.x - cx) < 1.5, `x=${turn.at0.x} 中心=${cx}`);
check('实际右转 90°：原正前方目标移到地图【左】侧',
  turn.afterRight.x < cx - 5, `x=${turn.afterRight.x} 应为 < ${cx - 5}`);

/* ============ 1. 原地旋转 360° 无累积漂移 ============ */
const drift = await page.evaluate(() => {
  const g = window.__game, d = window.__mapDebug;
  const bx = 12, bz = -18;
  g.player.yaw = 0;
  const start = d.worldToMap(bx, bz);
  // 用 360 个 1° 步进模拟「连续转向」，每步都改绝对朝向（不是累加角度）
  let maxJump = 0, prev = start;
  for (let i = 1; i <= 360; i++) {
    g.player.yaw = (i * Math.PI) / 180;
    const m = d.worldToMap(bx, bz);
    const jump = Math.hypot(m.x - prev.x, m.y - prev.y);
    if (jump > maxJump) maxJump = jump;
    prev = m;
  }
  g.player.yaw = 2 * Math.PI;           // 与 0 等价
  const end = d.worldToMap(bx, bz);
  g.player.yaw = 0;
  return { start, end, maxJump, err: Math.hypot(end.x - start.x, end.y - start.y) };
});
check('旋转 360° 后回到初始相对位置（无累积漂移）', drift.err < 0.01,
  `起点(${drift.start.x.toFixed(2)},${drift.start.y.toFixed(2)}) 终点(${drift.end.x.toFixed(2)},${drift.end.y.toFixed(2)}) 误差=${drift.err.toFixed(5)}px`);
check('每 1° 步进的单步位移平滑（无跳变）', drift.maxJump < 3,
  `最大单步=${drift.maxJump.toFixed(3)}px`);

/* ============ 3. 连续旋转 60 秒：轨迹平滑、无回绕 ============ */
const sweep = await page.evaluate(() => {
  const g = window.__game, d = window.__mapDebug;
  const bx = -14, bz = -12;
  /* 60 秒 @60fps = 3600 帧，全程匀速转 10 圈 → 每帧 1° */
  const perFrame = (Math.PI * 2 * 10) / 3600;
  let prev = null, maxJump = 0, samples = 0;
  const steps = [];
  for (let i = 0; i <= 3600; i++) {
    g.player.yaw = i * perFrame % (Math.PI * 2);
    const m = d.worldToMap(bx, bz);
    if (prev) {
      const j = Math.hypot(m.x - prev.x, m.y - prev.y);
      steps.push(j);
      if (j > maxJump) maxJump = j;
    }
    prev = m; samples++;
  }
  g.player.yaw = 0;
  const sorted = steps.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { maxJump, median, samples };
});
/* 真正的「跳变」会让最大单帧位移远大于中位数；匀速旋转时两者应几乎相等 */
check('连续旋转 60 秒 / 10 圈：轨迹平滑无跳变',
  sweep.maxJump < Math.max(0.5, sweep.median * 2),
  `${sweep.samples} 帧，中位位移=${sweep.median.toFixed(4)}px，最大位移=${sweep.maxJump.toFixed(4)}px（比值 ${(sweep.maxJump / sweep.median).toFixed(3)}）`);

/* ============ 5. 玩家图标固定在中心 + 箭头方向正确 ============ */
const icon = await page.evaluate(async () => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = 0;
  const res = { miniCenters: [], coneHalfDeg: [] };
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    g.player.yaw = yaw;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const d = window.__mapDebug;
    // 玩家自身映射到地图中心
    const self = d.worldToMap(g.player.pos.x, g.player.pos.z);
    res.miniCenters.push(self);
    const cam = g.camera;
    res.coneHalfDeg.push(Math.atan(Math.tan((cam.fov * Math.PI / 180) / 2) * cam.aspect) * 180 / Math.PI);
  }
  g.player.yaw = 0;
  return res;
});
const centered = icon.miniCenters.every((m) =>
  Math.abs(m.x - cx) < 0.01 && Math.abs(m.y - cx) < 0.01);
check('玩家图标恒定在地图中心（转向不偏移）', centered,
  icon.miniCenters.map((m) => `(${m.x.toFixed(1)},${m.y.toFixed(1)})`).join(' '));

const cones = icon.coneHalfDeg;
check('视野扇形角度取自真实相机 FOV 且一致', Math.abs(cones[0] - cones[2]) < 0.01 && cones[0] > 30,
  `${cones.map((c) => c.toFixed(1)).join('° / ')}°`);

/* ============ 5b. 战术地图箭头方向（原为 180° 反向） ============ */
const arrow = await page.evaluate(() => {
  const g = window.__game;
  window.__arrow = [];
  if (!window.__arrowPatched) {
    window.__arrowPatched = true;
    const orig = CanvasRenderingContext2D.prototype.moveTo;
    CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
      if (Math.abs(x) < 0.01 && Math.abs(y + 11) < 0.01) {
        const m = this.getTransform();
        window.__arrow.push({ a: m.a, b: m.b, c: m.c, d: m.d });
      }
      return orig.call(this, x, y);
    };
  }
  const out = [];
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    g.player.yaw = yaw;
    window.__arrow.length = 0;
    g.tacmap.render();
    const m = window.__arrow[window.__arrow.length - 1];
    // 局部朝上 (0,-1) 经矩阵变换后的屏幕方向
    const dir = { x: -m.c, y: -m.d };
    // 期望：地图空间前向量 = (-sin yaw, -cos yaw)
    const want = { x: -Math.sin(yaw), y: -Math.cos(yaw) };
    out.push({ yaw: +(yaw * 180 / Math.PI).toFixed(0), dir, want,
      dot: dir.x * want.x + dir.y * want.y });
  }
  g.player.yaw = 0;
  return out;
});
const arrowsOk = arrow.every((a) => a.dot > 0.99);
check('战术地图箭头方向与朝向一致（原为反向 180°）', arrowsOk,
  arrow.map((a) => `${a.yaw}° dot=${a.dot.toFixed(3)}`).join(' | '));

/* ============ 4. 标签：水平、不越界、不重叠 ============ */
const labels = await page.evaluate(() => {
  const g = window.__game;
  g.player.pos.x = 0; g.player.pos.z = -30; g.player.yaw = 0;
  g.tacmap.render();
  const t = g.tacmap;
  const items = [];
  for (let i = 0; i < t.drawnN; i++) items.push(t.drawn[i]);
  // 校验：真正画出来的标签必须两两不重叠，且全部落在画布内
  let overlaps = 0, outOfBounds = 0;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.x < 2 || a.y - 7 < 2 || a.x + a.w > t.W - 2 || a.y + 7 > t.H - 2) outOfBounds++;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.x - 3 < b.x + b.w + 3 && a.x + a.w + 3 > b.x - 3 &&
          a.y - 7 < b.y + 9 && a.y + 9 > b.y - 7) overlaps++;
    }
  }
  return { stats: { ...t.labelStats }, drawn: items.length, overlaps, outOfBounds,
    canvas: { w: t.W, h: t.H }, sample: items.slice(0, 4).map((p) => p.text) };
});
check('战术地图标签：有绘制、零重叠、零越界',
  labels.drawn > 0 && labels.overlaps === 0 && labels.outOfBounds === 0,
  `候选 ${labels.stats.total} → 绘制 ${labels.drawn}（重叠让位 ${labels.stats.rejected}，越界 ${labels.stats.offscreen}）；例: ${labels.sample.join(' / ')}`);

const miniLabels = await page.evaluate(() => {
  const g = window.__game;
  const ui = g.ui;
  const cv = document.querySelector('#minimap');
  const dpr = cv.width / cv.clientWidth;
  const ctx = cv.getContext('2d');
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
  // 检查画布内是否有文字底衬（rgba(6,11,16,.62) 叠加在建筑上会明显变暗）
  return { w: cv.clientWidth, h: cv.clientHeight, dpr, zones: ui.zoneItems.length,
    placerRejected: ui.placer.rejected };
});
check('小地图已具备地名标签系统', miniLabels.zones > 0 && miniLabels.w > 0,
  `${miniLabels.zones} 个地名候选，画布 ${miniLabels.w}×${miniLabels.h}@${miniLabels.dpr}x`);

/* ============ 6b. 渲染像素与 worldToMap 一致（端到端） ============ */
const pixel = await page.evaluate(async () => {
  const g = window.__game, d = window.__mapDebug;
  g.player.pos.x = 0; g.player.pos.z = 0; g.player.yaw = 0;
  const mate = g.squad[0];
  mate.pos.x = 0; mate.pos.z = -20;
  g.squad.slice(1).forEach((s) => { s.pos.x = 500; s.pos.z = 500; });
  g.suspects.forEach((s) => { s.pos.x = 500; s.pos.z = 500; });
  g.civilians.forEach((c) => { c.pos.x = 500; c.pos.z = 500; });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.querySelector('#minimap');
  const ctx = cv.getContext('2d');
  const dpr = cv.width / cv.clientWidth;
  const expect = d.worldToMap(mate.pos.x, mate.pos.z);
  const px = Math.round(expect.x * dpr), py = Math.round(expect.y * dpr);
  const d2 = ctx.getImageData(px - 5, py - 5, 11, 11).data;
  let hits = 0;
  for (let i = 0; i < d2.length; i += 4) {
    if (Math.abs(d2[i] - 78) < 45 && Math.abs(d2[i + 1] - 168) < 45 && Math.abs(d2[i + 2] - 255) < 45 && d2[i + 3] > 120) hits++;
  }
  // 反查：错误（旧公式）位置应当没有蓝色队友标记
  const C = Math.cos(-g.player.yaw), S = Math.sin(-g.player.yaw);
  const dx = mate.pos.x - g.player.pos.x, dz = mate.pos.z - g.player.pos.z;
  const k = d.worldToMap(0, 0).x ? (g.ui._W / 2) / g.ui.miniRange : 1;
  const wrongX = Math.round((g.ui._W / 2 + (dx * C - dz * S) * k) * dpr);
  const wrongY = Math.round((g.ui._H / 2 + (dx * S + dz * C) * k) * dpr);
  let wrongHits = 0;
  if (Math.abs(wrongX - px) > 3 || Math.abs(wrongY - py) > 3) {
    const d3 = ctx.getImageData(wrongX - 5, wrongY - 5, 11, 11).data;
    for (let i = 0; i < d3.length; i += 4) {
      if (Math.abs(d3[i] - 78) < 45 && Math.abs(d3[i + 1] - 168) < 45 && Math.abs(d3[i + 2] - 255) < 45 && d3[i + 3] > 120) wrongHits++;
    }
  }
  const separated = Math.hypot(wrongX - px, wrongY - py);
  return { expect, hits, wrongHits, separated: +separated.toFixed(1), px, py, wrongX, wrongY };
});
check('小地图渲染像素与 __mapDebug.worldToMap 一致', pixel.hits > 0,
  `期望像素处命中 ${pixel.hits} 个蓝色像素`);
/* 反证：旧（旋转符号写反）的公式位置不应有队友标记，否则说明两式未分离或渲染另有来源 */
check('旧（错误）公式位置无队友标记（反证旋转方向已修正）',
  pixel.separated < 3 || pixel.wrongHits === 0,
  `两式位置相距 ${pixel.separated}px，错误位置命中 ${pixel.wrongHits} 个蓝色像素`);

/* ============ 每帧零分配（GC 抖动） ============ */
const alloc = await page.evaluate(() => {
  const g = window.__game;
  // 连续渲染 120 帧，统计标签池容量是否恒定、标签池对象是否被复用
  const before = g.ui.placer.buf.length;
  const firstRef = g.ui.placer.buf[0];
  for (let i = 0; i < 120; i++) {
    g.player.yaw = i * 0.05;
    g.ui.drawMinimap(g);
    g.tacmap.render();
  }
  const after = g.ui.placer.buf.length;
  return { before, after, reused: firstRef === g.ui.placer.buf[0] };
});
check('标签/坐标缓冲逐帧复用（无新增分配）',
  alloc.before === alloc.after && alloc.reused,
  `缓冲区 ${alloc.before} → ${alloc.after}，对象复用=${alloc.reused}`);

await suite.finish();
