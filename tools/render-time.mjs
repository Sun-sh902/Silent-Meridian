/* ============================================================
   tools/render-time.mjs — main-scene + viewmodel render time at fixed poses (relative GPU cost indicator)
   ------------------------------------------------------------
   Usage: node tools/render-time.mjs [--root <worktree>] [--query "&nopost"] [--frames 30] [--eval "<js run in page first>"] [--ab]
   --ab: post-processing on vs off measured in the same page, alternating every 4 frames, so machine-load drift
         (large under swiftshader) cancels out. Reports the ratio.
   Under swiftshader the absolute numbers mean little (software rasteriser), but the ratio between two
   builds on the same machine tracks fragment cost (lights, post passes). gl.finish() is called so the
   timing covers the actual draw, not just command submission.
   gl.finish() alone does not block under swiftshader, so a 1-pixel readPixels forces the sync.
   ============================================================ */
import { resolve } from 'node:path';
import { Suite, ROOT } from './harness.mjs';
import { POSES } from './poses.mjs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FRAMES = Number(argOf('--frames', '30'));
const suite = new Suite('render-time', { failOnPageError: true });
await suite.serve({ port: Number(argOf('--port', '8241')), root: resolve(argOf('--root', ROOT)) });
await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await suite.newPage();
await page.goto(`http://127.0.0.1:${argOf('--port', '8241')}/?deploy=1&test=1${argOf('--query', '')}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state === 'play', { timeout: 20000 });
if (argOf('--eval', '')) await page.evaluate(argOf('--eval', ''));   // experiments, e.g. swap a material
const AB = argv.includes('--ab');
const out = await page.evaluate((poses, FRAMES, AB) => {
  const g = window.__game; const gl = g.renderer.getContext(); const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const draw = () => {
    if (g.renderFrame) g.renderFrame();
    else { g.renderer.autoClear = true; g.renderer.render(g.scene, g.camera); g.renderer.autoClear = false; g.viewmodel.render(g.renderer); g.renderer.autoClear = true; }
  };
  const res = [];
  for (const p of poses) {
    g.player.pos.x = p.pos[0]; g.player.pos.z = p.pos[1]; g.player.yaw = p.yaw; g.player.pitch = p.pitch;
    for (let i = 0; i < 10; i++) g.advance(1 / 60, 1 / 60);
    for (let i = 0; i < 3; i++) { draw(); sync(); }   // warm-up: shader compile / lazy uploads
    if (AB && g.post) {
      const post = g.post; let on = 0, off = 0;
      g.post = null; for (let i = 0; i < 2; i++) { draw(); sync(); } g.post = post;
      for (let k = 0; k < FRAMES / 4; k++) {
        let t = performance.now(); for (let i = 0; i < 4; i++) { draw(); sync(); } on += performance.now() - t;
        g.post = null; g.renderer.setRenderTarget(null);
        t = performance.now(); for (let i = 0; i < 4; i++) { draw(); sync(); } off += performance.now() - t;
        g.post = post;
      }
      res.push({ pose: p.name, ms: +(on / FRAMES).toFixed(2), off: +(off / FRAMES).toFixed(2) });
      continue;
    }
    const t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) { draw(); sync(); }
    res.push({ pose: p.name, ms: +((performance.now() - t0) / FRAMES).toFixed(2) });
  }
  return res;
}, POSES, FRAMES, AB);
for (const r of out) suite.info(r.pose, r.ms + ' ms/frame' + (r.off !== undefined ? ` (post off ${r.off} ms, ×${(r.ms / r.off).toFixed(3)})` : ''));
if (AB) {
  const on = out.reduce((a, r) => a + r.ms, 0), off = out.reduce((a, r) => a + r.off, 0);
  suite.info('post cost', `×${(on / off).toFixed(3)} (${((on / off - 1) * 100).toFixed(1)}%)`);
}
suite.info('mean', (out.reduce((a, r) => a + r.ms, 0) / out.length).toFixed(2) + ' ms/frame');
await suite.finish();
