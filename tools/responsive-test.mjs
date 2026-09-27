/* ============================================================
   tools/responsive-test.mjs — 响应式验收测试
   ------------------------------------------------------------
   1) 宽度扫描：1920 / 1440 / 1280 / 1024 / 768 / 480（模拟拖动窗口）
   2) 缩放扫描：50% / 75% / 100% / 125% / 150%
      （浏览器缩放 = CSS 视口变小 + devicePixelRatio 变大，按此模拟）
   每个组合检查：
     · 无横向滚动条
     · 关键面板两两不重叠
     · 文字不溢出容器、不出viewport
     · 最小字号 ≥ 12px
     · canvas backing store = CSS 尺寸 × DPR（清晰不变形）
   用法： node tools/responsive-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('responsive-test');
const server = await suite.serve({ port: 8202 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await suite.newPage();

/* 布局审计必须在「动画已静止」的状态下测量。
   否则 .log-item 的入场动画（logIn 从 translateX(14px) 起步）会让一个刚出现的
   日志项在动画期间被 getBoundingClientRect() 判定为越界 —— 属于纯粹的时间竞态，
   会让本套件间歇性变红（见 ui.css 的 prefers-reduced-motion 块）。
   同时这也让「减少动态效果」这一真实用户配置下的布局得到覆盖。 */
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failuresList = [];

/* ---------------- 页面内检查脚本 ---------------- */
const CHECK = `(() => {
  const out = { hScroll: [], overlaps: [], textOverflow: [], smallFont: [], canvases: [], offscreen: [] };
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /* 1. 横向滚动条 */
  const de = document.documentElement, bd = document.body;
  if (de.scrollWidth > de.clientWidth + 1) out.hScroll.push('documentElement ' + de.scrollWidth + '>' + de.clientWidth);
  if (bd.scrollWidth > bd.clientWidth + 1) out.hScroll.push('body ' + bd.scrollWidth + '>' + bd.clientWidth);

  /* 2. 关键面板两两重叠 */
  const PANELS = ['#objective-panel','#compass-wrap','#status-panel','#mini-map','#squad-panel',
                  '#weapon-panel','#hint-bar','#log','#radio-feed','#hud-bottom-center','#cursor-hint'];
  const live = PANELS.map((s) => document.querySelector(s)).filter(vis);
  const rects = live.map((el) => ({ el, sel: '#' + el.id, r: el.getBoundingClientRect() }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;   // 父子不算
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox > 2 && oy > 2) {
        out.overlaps.push(a.sel + ' × ' + b.sel + ' 重叠 ' + Math.round(ox) + '×' + Math.round(oy) + 'px');
      }
    }
  }

  /* 3. 文字溢出 + 4. 最小字号 + 5. 越界 */
  const textEls = document.querySelectorAll('body *');
  for (const el of textEls) {
    if (!vis(el)) continue;
    if (el.tagName === 'CANVAS' || el.tagName === 'SVG') continue;
    const cs = getComputedStyle(el);
    // 直接含文本节点才判断
    let hasText = false;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length) hasText = true;
    if (!hasText) continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11.9 && el.offsetParent !== null) {
      out.smallFont.push((el.id || el.className || el.tagName) + ' = ' + fs.toFixed(1) + 'px');
    }
    // 只有这两处是「有意裁切」的次要信息流，其余任何裁切都算缺陷
    const intentionalClip = !!el.closest('#log, #radio-feed');
    if (!intentionalClip && el.scrollWidth > el.clientWidth + 2) {
      out.textOverflow.push((el.id || el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
    if (!intentionalClip && el.scrollHeight > el.clientHeight + 2 &&
        cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') {
      out.textOverflow.push((el.id || el.className || el.tagName) + ' 纵向裁切 ' +
        el.scrollHeight + '>' + el.clientHeight);
    }
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) {
      out.offscreen.push((el.id || el.className || el.tagName) + ' x=[' + Math.round(r.left) + ',' + Math.round(r.right) + '] vw=' + vw);
    }
  }

  /* 6. canvas 清晰度与比例 */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  document.querySelectorAll('canvas').forEach((cv) => {
    if (!vis(cv)) return;
    const r = cv.getBoundingClientRect();
    const ew = Math.round(r.width * dpr), eh = Math.round(r.height * dpr);
    const okW = Math.abs(cv.width - ew) <= 1, okH = Math.abs(cv.height - eh) <= 1;
    const cssRatio = r.width / r.height, bufRatio = cv.width / cv.height;
    const okRatio = Math.abs(cssRatio - bufRatio) / cssRatio < 0.02;
    if (!okW || !okH || !okRatio) {
      out.canvases.push((cv.id || 'canvas') + ' buf=' + cv.width + 'x' + cv.height +
        ' 期望=' + ew + 'x' + eh + ' 比例 ' + cssRatio.toFixed(3) + '/' + bufRatio.toFixed(3));
    }
  });
  return out;
})()`;

async function audit(label, viewport) {
  if (viewport) {
    const before = await page.evaluate(() => (window.__game ? window.__game.resizeCount : 0));
    await page.setViewport({ ...viewport, isMobile: false });
    // 必须等页面真的处理完这次尺寸变化（ResizeObserver → resize()），
    // 否则会在 canvas 还没重绘时误判为「不清晰」
    try {
      await page.waitForFunction((n) => window.__game && window.__game.resizeCount > n,
        { timeout: 8000, polling: 100 }, before);
    } catch (e) { /* 未进入游戏时没有 resizeCount，忽略 */ }
    // 再等两帧，让 HUD 的 canvas 重绘完成
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  await wait(120);
  const r = await page.evaluate(CHECK);
  const problems = [];
  for (const k of ['hScroll', 'overlaps', 'textOverflow', 'smallFont', 'canvases', 'offscreen']) {
    for (const msg of r[k]) problems.push(k + ': ' + msg);
  }
  const ok = problems.length === 0;
  suite.check(label, ok, ok ? '' : problems.slice(0, 3).join(' | '));
  if (!ok) {
    failuresList.push({ label, problems });
    problems.slice(0, 6).forEach((p) => console.log('    ' + p));
    if (problems.length > 6) console.log(`    … 另有 ${problems.length - 6} 项`);
  }
  return problems.length;
}

/* ============ 1. 宽度扫描（模拟拖动窗口） ============ */
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:8202/?deploy=1&pos=0,-30', { waitUntil: 'load' });
await wait(2600);

console.log('\n===== A. 窗口宽度扫描（游戏中 HUD） =====');
for (const w of [1920, 1440, 1280, 1024, 900, 768, 600, 480]) {
  await audit(`游戏中 ${w}×${Math.round(w * 0.62)}`, { width: w, height: Math.round(w * 0.62), deviceScaleFactor: 1 });
}

console.log('\n===== B. 浏览器缩放扫描（物理窗口 1440×900） =====');
for (const z of [0.5, 0.75, 1, 1.25, 1.5]) {
  await audit(`缩放 ${Math.round(z * 100)}%  → CSS ${Math.round(1440 / z)}×${Math.round(900 / z)} @ dpr ${z}`,
    { width: Math.round(1440 / z), height: Math.round(900 / z), deviceScaleFactor: z });
}

/* ============ 3. 菜单界面 ============ */
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await wait(300);
console.log('\n===== C. 菜单界面（标题 / 简报 / 配装 / 说明） =====');
const SCREENS = [['title', '标题'], ['briefing', '行动简报'], ['loadout', '装备配置'], ['help', '操作说明']];
for (const [screen, name] of SCREENS) {
  for (const w of [1920, 1440, 1024, 768, 480]) {
    await page.evaluate((s) => window.__game.screens.show(s), screen);
    await audit(`${name} ${w}px`, { width: w, height: Math.max(560, Math.round(w * 0.62)), deviceScaleFactor: 1 });
  }
}

/* 战果面板 + 暂停面板：这两屏字号最大，最容易溢出 */
console.log('\n===== D. 战果 / 暂停面板 =====');
for (const w of [1920, 1440, 1024, 768, 480]) {
  await page.evaluate(() => {
    window.__game.screens.showDebrief({
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
    window.__game.screens.show('debrief');
  });
  await audit(`战果面板 ${w}px`, { width: w, height: Math.max(600, Math.round(w * 0.62)), deviceScaleFactor: 1 });
}

await suite.finish();
