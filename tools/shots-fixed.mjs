/* ============================================================
   tools/shots-fixed.mjs — fixed-pose screenshots + value statistics (the ruler for the visual overhaul)
   ------------------------------------------------------------
   Usage:
     node tools/shots-fixed.mjs [--out /tmp/shots] [--tag now] [--repeat 1]
                                [--poses yard-center,dock-edge] [--query "&nopost"]
                                [--hud] [--port 8233] [--root <another worktree>] [--pose name,x,z,yaw,pitch] [--reduced-motion]
                                [--first-frame] [--size 2100x900]
     node tools/shots-fixed.mjs --pair /tmp/shots/before /tmp/shots/after [--out /tmp/shots/pairs]

   Method:
     · every pose reloads the page (?deploy=1&test=1); Math.random is replaced with a fixed seed
       (the same xorshift as feel-baseline); textures come from textures.js's own deterministic stream;
     · ?test=1 freezes rAF; game.advance() is driven here at a fixed 1/60 s step,
       then game.renderFrame() draws one frame — no wall clock, frame content depends only on step count;
     · AI is frozen (feel.debug.freezeAI is a runtime switch; feel.js is not edited),
       so compositions are unaffected by AI changes;
     · the HUD is hidden but #grade / #vignette are kept — the stats describe what the player actually sees.
   Statistics (per pixel, sRGB 0..255):
     mean   mean luminance (Rec.709 weights)
     crush  crushed-black share (luminance < 8)
     mid    midtone share (32 ≤ luminance ≤ 200)
     clip   highlight clipping share (any channel > 248)
     sat    mean saturation (HSV S)
   With --repeat N each pose is shot N times and the hashes compared (criterion: pixel-identical).
   ============================================================ */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Suite, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(argOf('--port', '8233'));
/* --size WxH: viewport for aspect-ratio checks (default 1600×900) */
const SIZE = (() => { const i = argv.indexOf('--size'); return i >= 0 && argv[i + 1] ? argv[i + 1].split('x').map(Number) : [1600, 900]; })();
const W = SIZE[0], H = SIZE[1];

import { POSES } from './poses.mjs';

const suite = new Suite('shots-fixed', { failOnPageError: true });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});

/* decode the PNG and compute stats in the browser (no node-side image dependency) */
async function statsOf(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sumL = 0, crush = 0, mid = 0, clip = 0, sumS = 0;
    const hist = new Array(8).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      sumL += L;
      if (L < 8) crush++;
      if (L >= 32 && L <= 200) mid++;
      if (r > 248 || gg > 248 || b > 248) clip++;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      sumS += mx > 0 ? (mx - mn) / mx : 0;
      hist[Math.min(7, L >> 5)]++;
      n++;
    }
    const pct = (v) => +(100 * v / n).toFixed(2);
    return {
      mean: +(sumL / n).toFixed(2), crush: pct(crush), mid: pct(mid), clip: pct(clip),
      sat: +(sumS / n).toFixed(3), hist: hist.map(pct),
    };
  }, png.toString('base64'));
}

async function shootPose(pose, query, withHud) {
  const page = await suite.newPage();
  if (REDUCED) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    let seed = 0x2f6e2b1;
    Math.random = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };
  });
  const url = `http://127.0.0.1:${PORT}/?deploy=1&test=1${query || ''}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'play' && window.__game.player, { timeout: 20000 });
  const res = await page.evaluate((p) => {
    const g = window.__game;
    const P = g.player;
    const DT = 1 / 60;
    g.testMode = true;
    window.__feel.debug.freezeAI = true;   // runtime switch; feel.js is not edited
    g.input.keys.clear();
    g.input.lmb = false; g.input.rmb = false; g.input.lmbPressed = false;
    if (!p.spawn) { P.pos.x = p.pos[0]; P.pos.z = p.pos[1]; P.yaw = p.yaw; P.pitch = p.pitch; }
    P.vel = 0; P.ads = 0;
    g.clock = p.clock;
    for (let i = 0; i < p.steps; i++) {
      g.clock = p.clock;   // pin the in-game clock (advance moves it)
      g.advance(DT, DT);
    }
    if (g.renderFrame) g.renderFrame();
    else {   // older builds (pre-overhaul) have no renderFrame: render manually in the original loop() order
      g.renderer.autoClear = true; g.renderer.render(g.scene, g.camera);
      g.renderer.autoClear = false; g.viewmodel.render(g.renderer); g.renderer.autoClear = true;
    }
    return { fov: +g.camera.fov.toFixed(3), x: +g.camera.position.x.toFixed(3), z: +g.camera.position.z.toFixed(3) };
  }, pose);
  /* hide the HUD and overlays before capture; #grade/#vignette are part of the image and stay */
  await page.evaluate((hud) => {
    const keep = new Set(['view', 'grade', 'vignette']);
    for (const el of document.querySelectorAll('#app > *')) {
      if (!keep.has(el.id) && !hud) el.style.visibility = 'hidden';
    }
  }, !!withHud);
  const png = Buffer.from(await page.screenshot({ type: 'png' }));   // newer puppeteer returns a Uint8Array
  const stats = await statsOf(page, png);
  /* Second capture: the bare canvas without the CSS overlays (#grade/#vignette), to separate "lighting" from "CSS veil".
     Once phase 4 moves grading into the shader these CSS layers are gone and the two sets of numbers should converge. */
  await page.evaluate(() => {
    for (const id of ['grade', 'vignette']) { const el = document.getElementById(id); if (el) el.style.visibility = 'hidden'; }
  });
  const rawPng = Buffer.from(await page.screenshot({ type: 'png' }));
  const raw = await statsOf(page, rawPng);
  await page.close();
  return { png, rawPng, stats, raw, cam: res };
}

/* ---------------- --pair: build before/after comparison images ---------------- */
if (argv.includes('--pair')) {
  const i = argv.indexOf('--pair');
  const A = resolve(argv[i + 1]), B = resolve(argv[i + 2]);
  const OUT = resolve(argOf('--out', join(B, '..', 'pairs')));
  await mkdir(OUT, { recursive: true });
  const page = await suite.newPage();
  await page.setContent('<html><body style="margin:0;background:#000"></body></html>');
  for (const pose of POSES) {
    let a, b;
    try { a = await readFile(join(A, pose.name + '.png')); b = await readFile(join(B, pose.name + '.png')); } catch (e) { continue; }
    const out = await page.evaluate(async (a64, b64, name) => {
      const load = async (s) => { const im = new Image(); im.src = 'data:image/png;base64,' + s; await im.decode(); return im; };
      const ia = await load(a64), ib = await load(b64);
      const w = 800, h = Math.round(ia.height * (800 / ia.width));
      const c = document.createElement('canvas'); c.width = w * 2 + 8; c.height = h + 28;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(ia, 0, 28, w, h); g.drawImage(ib, w + 8, 28, w, h);
      g.fillStyle = '#ccc'; g.font = '14px monospace';
      g.fillText(name + ' — BEFORE', 8, 19); g.fillText(name + ' — AFTER', w + 16, 19);
      return c.toDataURL('image/png').split(',')[1];
    }, a.toString('base64'), b.toString('base64'), pose.name);
    await writeFile(join(OUT, pose.name + '.png'), Buffer.from(out, 'base64'));
    suite.info('pair ' + pose.name, join(OUT, pose.name + '.png'));
  }
  await suite.finish();
}

/* ---------------- Normal capture ---------------- */
const TAG = argOf('--tag', 'now');
const OUT = resolve(argOf('--out', '/tmp/shots'), TAG);
const REPEAT = Math.max(1, Number(argOf('--repeat', '1')));
const QUERY = argOf('--query', '');
const WANT = argOf('--poses', '');
const WITH_HUD = argv.includes('--hud');
const REDUCED = argv.includes('--reduced-motion');   // emulate prefers-reduced-motion: grain and aberration must switch off
let poses = WANT ? POSES.filter((p) => WANT.split(',').includes(p.name)) : POSES;
/* --first-frame: the real first frame of a mission (player spawn as authored in world.js, nothing overridden) */
if (argv.includes('--first-frame')) poses = [{ name: 'first-frame', spawn: true, clock: 23 * 3600 + 41 * 60, steps: 40 }];
/* --pose name,x,z,yaw,pitch : an ad-hoc pose instead of the named set (for spot checks, not for the report) */
if (argOf('--pose', '')) {
  const [name, x, z, yaw, pitch] = argOf('--pose', '').split(',');
  poses = [{ name, pos: [Number(x), Number(z)], yaw: Number(yaw), pitch: Number(pitch || 0), fov: 72, clock: 23 * 3600 + 50 * 60, steps: 40 }];
}

await suite.serve({ port: PORT, root: resolve(argOf('--root', ROOT)) });
await mkdir(OUT, { recursive: true });

const table = [];
for (const pose of poses) {
  const hashes = [];
  let last = null;
  for (let r = 0; r < REPEAT; r++) {
    const shot = await shootPose(pose, QUERY, WITH_HUD);
    hashes.push(createHash('sha256').update(shot.png).digest('hex').slice(0, 16));
    last = shot;
  }
  await writeFile(join(OUT, pose.name + '.png'), last.png);
  await writeFile(join(OUT, pose.name + '.raw.png'), last.rawPng);
  const s = last.stats, w = last.raw;
  table.push({ pose: pose.name, ...s, raw: w, hash: hashes[0] });
  if (REPEAT > 1) {
    suite.check(`${pose.name} ×${REPEAT} pixel-identical`, hashes.every((h) => h === hashes[0]), hashes.join(' '));
  }
  suite.info(pose.name,
    `mean ${s.mean}  crush ${s.crush}%  mid ${s.mid}%  clip ${s.clip}%  sat ${s.sat}  hist[32] ${s.hist.join('/')}`);
  suite.info(pose.name + ' (raw)',
    `mean ${w.mean}  crush ${w.crush}%  mid ${w.mid}%  clip ${w.clip}%  sat ${w.sat}`);
}

const avg = (k, raw) => +(table.reduce((a, r) => a + (raw ? r.raw : r)[k], 0) / table.length).toFixed(2);
suite.info('average', `mean ${avg('mean')}  crush ${avg('crush')}%  mid ${avg('mid')}%  clip ${avg('clip')}%  sat ${avg('sat')}`);
suite.info('average (raw)', `mean ${avg('mean', 1)}  crush ${avg('crush', 1)}%  mid ${avg('mid', 1)}%  clip ${avg('clip', 1)}%  sat ${avg('sat', 1)}`);
await writeFile(join(OUT, 'stats.json'), JSON.stringify({ tag: TAG, query: QUERY, poses: table }, null, 2) + '\n');
suite.info('output', OUT);
await suite.finish();
