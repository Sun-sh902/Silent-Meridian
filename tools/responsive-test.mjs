/* ============================================================
   tools/responsive-test.mjs — responsive acceptance test
   ------------------------------------------------------------
   1) width sweep: 1920 / 1440 / 1280 / 1024 / 768 / 480 (simulates window dragging)
   2) zoom sweep: 50% / 75% / 100% / 125% / 150%
      (browser zoom = smaller CSS viewport + larger devicePixelRatio, simulated that way)
   Each combination checks:
     · no horizontal scrollbar
     · key panels never overlap pairwise
     · text doesn't overflow its container or leave the viewport
     · minimum font size ≥ 12px
     · canvas backing store = CSS size × DPR (sharp, undistorted)
   Usage: node tools/responsive-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('responsive-test');
const server = await suite.serve({ port: 8202 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await suite.newPage();

/* The layout audit must measure with animations at rest.
   Otherwise .log-item's entry animation (logIn starts at translateX(14px)) makes a freshly added
   log item read as out of bounds via getBoundingClientRect() mid-animation — a pure timing race
   that turned this suite intermittently red (see the prefers-reduced-motion block in ui.css).
   It also covers layout under the real-world "reduce motion" user setting. */
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failuresList = [];

/* ---------------- In-page check script ---------------- */
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

  /* 1. horizontal scrollbar */
  const de = document.documentElement, bd = document.body;
  if (de.scrollWidth > de.clientWidth + 1) out.hScroll.push('documentElement ' + de.scrollWidth + '>' + de.clientWidth);
  if (bd.scrollWidth > bd.clientWidth + 1) out.hScroll.push('body ' + bd.scrollWidth + '>' + bd.clientWidth);

  /* 2. pairwise key-panel overlap */
  const PANELS = ['#objective-panel','#compass-wrap','#status-panel','#mini-map','#squad-panel',
                  '#weapon-panel','#hint-bar','#log','#radio-feed','#hud-bottom-center','#cursor-hint'];
  const live = PANELS.map((s) => document.querySelector(s)).filter(vis);
  const rects = live.map((el) => ({ el, sel: '#' + el.id, r: el.getBoundingClientRect() }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;   // parent/child doesn't count
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox > 2 && oy > 2) {
        out.overlaps.push(a.sel + ' × ' + b.sel + ' overlap ' + Math.round(ox) + '×' + Math.round(oy) + 'px');
      }
    }
  }

  /* 3. text overflow + 4. minimum font size + 5. out of bounds */
  const textEls = document.querySelectorAll('body *');
  for (const el of textEls) {
    if (!vis(el)) continue;
    if (el.tagName === 'CANVAS' || el.tagName === 'SVG') continue;
    const cs = getComputedStyle(el);
    // only elements that directly contain text nodes
    let hasText = false;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length) hasText = true;
    if (!hasText) continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11.9 && el.offsetParent !== null) {
      out.smallFont.push((el.id || el.className || el.tagName) + ' = ' + fs.toFixed(1) + 'px');
    }
    // only these two are deliberately clipped secondary feeds; any other clipping is a defect
    const intentionalClip = !!el.closest('#log, #radio-feed');
    if (!intentionalClip && el.scrollWidth > el.clientWidth + 2) {
      out.textOverflow.push((el.id || el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
    if (!intentionalClip && el.scrollHeight > el.clientHeight + 2 &&
        cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') {
      out.textOverflow.push((el.id || el.className || el.tagName) + ' clipped vertically ' +
        el.scrollHeight + '>' + el.clientHeight);
    }
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) {
      out.offscreen.push((el.id || el.className || el.tagName) + ' x=[' + Math.round(r.left) + ',' + Math.round(r.right) + '] vw=' + vw);
    }
  }

  /* 6. canvas sharpness and aspect */
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
        ' expected=' + ew + 'x' + eh + ' aspect ' + cssRatio.toFixed(3) + '/' + bufRatio.toFixed(3));
    }
  });
  return out;
})()`;

async function audit(label, viewport) {
  if (viewport) {
    const before = await page.evaluate(() => (window.__game ? window.__game.resizeCount : 0));
    await page.setViewport({ ...viewport, isMobile: false });
    // wait until the page has really processed this resize (ResizeObserver → resize()),
    // otherwise a canvas that hasn't redrawn yet is misreported as "not sharp"
    try {
      await page.waitForFunction((n) => window.__game && window.__game.resizeCount > n,
        { timeout: 8000, polling: 100 }, before);
    } catch (e) { /* no resizeCount before entering the game; ignore */ }
    // wait two more frames for the HUD canvases to redraw
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
    if (problems.length > 6) console.log(`    … ${problems.length - 6} more`);
  }
  return problems.length;
}

/* ============ 1. width sweep (simulates window dragging) ============ */
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:8202/?deploy=1&pos=0,-30', { waitUntil: 'load' });
await wait(2600);

/* ============ 0. reduced motion reaches the renderer too ============
   Every time-varying visual effect (post grain and chromatic aberration) must switch off under
   prefers-reduced-motion, not only the CSS animations. This page already emulates it. */
{
  const rm = await page.evaluate(() => {
    const g = window.__game;
    if (!g.post) return { post: false };
    const u = g.post.composite.uniforms;
    g.renderFrame();
    return { post: true, grain: u.grain.value, aberration: u.aberration.value, cssVeils: getComputedStyle(document.getElementById('grade')).display };
  });
  suite.check('reduced motion: post grain and aberration off, CSS veils replaced by the shader grade',
    rm.post && rm.grain === 0 && rm.aberration === 0 && rm.cssVeils === 'none', JSON.stringify(rm));
}

console.log('\n===== A. Window width sweep (in-game HUD) =====');
for (const w of [1920, 1440, 1280, 1024, 900, 768, 600, 480]) {
  await audit(`in game ${w}×${Math.round(w * 0.62)}`, { width: w, height: Math.round(w * 0.62), deviceScaleFactor: 1 });
}

console.log('\n===== B. Browser zoom sweep (physical window 1440×900) =====');
for (const z of [0.5, 0.75, 1, 1.25, 1.5]) {
  await audit(`zoom ${Math.round(z * 100)}%  → CSS ${Math.round(1440 / z)}×${Math.round(900 / z)} @ dpr ${z}`,
    { width: Math.round(1440 / z), height: Math.round(900 / z), deviceScaleFactor: z });
}

/* ============ 3. menu screens ============ */
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await wait(300);
console.log('\n===== C. Menu screens (title / briefing / loadout / controls) =====');
const SCREENS = [['title', 'title'], ['briefing', 'briefing'], ['loadout', 'loadout'], ['help', 'controls']];
for (const [screen, name] of SCREENS) {
  for (const w of [1920, 1440, 1024, 768, 480]) {
    await page.evaluate((s) => window.__game.screens.show(s), screen);
    await audit(`${name} ${w}px`, { width: w, height: Math.max(560, Math.round(w * 0.62)), deviceScaleFactor: 1 });
  }
}

/* debrief + pause panels: the largest type, most likely to overflow */
console.log('\n===== D. Debrief / pause panels =====');
for (const w of [1920, 1440, 1024, 768, 480]) {
  await page.evaluate(() => {
    window.__game.screens.showDebrief({
      success: true, grade: 'A', comment: 'Clean and measured. Movement and fire discipline to Port Security SOP.',
      time: '7:24', shots: 61, accuracy: 38, blindShots: 3, detained: 3, killed: 1, escaped: 0,
      suspectTotal: 9, civSafe: 4, civLost: 0, civTotal: 4, orders: 11, squadDown: 0, gadgets: 2,
      objectives: { manifest: 'done', evidence: 'done', civilians: 'done', suspects: 'done', extract: 'done' },
      squad: [
        { callsign: 'LEAD', role: 'Standard vest', alive: true, hp: 96, maxHp: 120 },
        { callsign: 'ARDEN-2', role: 'RIFLEMAN · RECON', alive: true, hp: 118, maxHp: 130 },
        { callsign: 'BRAM-3', role: 'RIFLEMAN · FIRE SUPPORT', alive: true, hp: 74, maxHp: 130 },
        { callsign: 'CIRA-4', role: 'BREACHER · ENTRY', alive: true, hp: 130, maxHp: 130 },
        { callsign: 'DOV-5', role: 'MEDIC · SUPPORT', alive: true, hp: 101, maxHp: 130 },
      ],
    });
    window.__game.screens.show('debrief');
  });
  await audit(`debrief panel ${w}px`, { width: w, height: Math.max(600, Math.round(w * 0.62)), deviceScaleFactor: 1 });
}

await suite.finish();
