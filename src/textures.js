/* ============================================================
   textures.js — procedural canvas textures (invented marks / surface detail)
   ============================================================ */
import * as THREE from 'three';
import { makeRng } from './geom.js';

/* Deterministic random stream for textures only; never reads Math.random,
   so textures are pixel-identical on every boot / deploy and screenshots can be compared before/after.
   buildWorld() calls reseedTextures() first, so a redeploy restarts the same sequence. */
const TEX_SEED = 0x7e57a11;
let _rng = makeRng(TEX_SEED);
export function reseedTextures(seed = TEX_SEED) { _rng = makeRng(seed >>> 0); }
export function rand() { return _rng.next(); }

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function toTex(canvas, repeat) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/* ---------------- Concrete / asphalt ---------------- */
/* ---------------- Shared helpers for tileable surfaces ---------------- */
/* draw fn at every wrap offset whose footprint touches the tile, so features crossing an edge continue on the far side */
function wrapped(w, h, x, y, r, fn) {
  for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
    const X = x + dx, Y = y + dy;
    if (X + r >= 0 && X - r <= w && Y + r >= 0 && Y - r <= h) fn(X, Y);
  }
}
/* greyscale height canvas → tangent-space normal map (Sobel, wrapping at the edges) */
function normalFromHeight(hc, strength) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = mkCanvas(w, h), og = out.getContext('2d');
  const img = og.createImageData(w, h), d = img.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}
function dataTex(canvas, repeat) {
  const t = toTex(canvas, repeat);
  t.colorSpace = THREE.NoColorSpace;      // normal / mask data, not colour
  return t;
}

/* ---------------- Asphalt (ground) ----------------
   1024² covering 4 m × 4 m (256 px/m, the surface seen closest). Weathered asphalt, albedo ~0.05–0.07 linear,
   aggregate grain, a tar-sealed crack network and one paving seam per tile. The colour map and the height-derived
   normal map share the same features, so grain and cracks catch grazing light instead of being painted on. */
export const ASPHALT_TILE_M = 4;
export function asphaltSet() {
  /* Generated straight into typed arrays: an earlier version issued ~40k canvas draw calls (arcs, gradients),
     which left a huge deferred display list and external memory behind and measurably slowed every later
     GC — i.e. game logic — by 10–15%. Pixel loops are faster to build and leave nothing behind. */
  const S = 1024, N = S * S;
  const col = new Float32Array(N), hgt = new Float32Array(N);
  col.fill(60); hgt.fill(0.5);
  const idx = (x, y) => ((y & (S - 1)) * S) + (x & (S - 1));          // S is a power of two: & wraps
  const disc = (cx, cy, r, fn) => {
    const r2 = r * r, x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 <= r2) fn(idx(x, y), d2 / r2);
    }
  };
  // fines: low-contrast mottling (soft blobs)
  for (let i = 0; i < 900; i++) {
    const cx = rand() * S, cy = rand() * S, r = 8 + rand() * 30, dv = (rand() - 0.5) * 14;
    disc(cx, cy, r, (k, t) => { col[k] += dv * (1 - t); });
  }
  // aggregate: small stones, lighter and raised
  for (let i = 0; i < 26000; i++) {
    const cx = rand() * S, cy = rand() * S, r = 0.8 + rand() * rand() * 3.2, v = 62 + rand() * 34, a = 0.25 + rand() * 0.35;
    const h = 0.18 + rand() * 0.25;
    disc(cx, cy, r * 1.2, (k, t) => {
      if (t < 0.7) col[k] += (v - col[k]) * a;
      hgt[k] = Math.min(1, hgt[k] + h * (1 - t));
    });
  }
  // voids between stones: darker and lower
  for (let i = 0; i < 14000; i++) {
    const k = idx(Math.floor(rand() * S), Math.floor(rand() * S));
    col[k] += (18 - col[k]) * 0.45; hgt[k] = Math.max(0, hgt[k] - 0.35);
  }
  // tar-sealed cracks: meandering, sealant darker and slightly proud of the surface
  for (let c = 0; c < 7; c++) {
    let x = rand() * S, y = rand() * S, a = rand() * 6.28;
    const n = 30 + Math.floor(rand() * 60), w = (3 + rand() * 5) / 2;
    for (let i = 0; i < n * 9; i++) {
      disc(x, y, w, (k) => { col[k] += (16 - col[k]) * 0.75; hgt[k] = 0.65; });
      x += Math.cos(a); y += Math.sin(a);
      if (i % 9 === 8) a += (rand() - 0.5) * 0.9;
    }
  }
  // paving seam: one saw-cut joint across the tile (every 4 m along one axis), a groove with a sealant line
  const sy = S / 2;
  for (let y = sy - 4; y < sy + 5; y++) for (let x = 0; x < S; x++) {
    const k = idx(x, y);
    if (y < sy + 3) { col[k] += (20 - col[k]) * 0.85; hgt[k] = 0.05; } else col[k] += (90 - col[k]) * 0.25;
  }
  // pack colour (neutral grey with a hint of blue-black binder) and height
  const c = mkCanvas(S, S), g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  const hc = mkCanvas(S, S), hg = hc.getContext('2d'), himg = hg.createImageData(S, S), hd = himg.data;
  for (let k = 0, i = 0; k < N; k++, i += 4) {
    const v = Math.max(0, Math.min(255, col[k]));
    d[i] = v; d[i + 1] = v + 1; d[i + 2] = v + 3; d[i + 3] = 255;
    const h = Math.max(0, Math.min(255, hgt[k] * 255));
    hd[i] = hd[i + 1] = hd[i + 2] = h; hd[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); hg.putImageData(himg, 0, 0);
  const map = toTex(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  const normalMap = dataTex(normalFromHeight(hc, 1.6));
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = 8;
  return { map, normalMap };
}

/* ---------------- Ground wetness mask ----------------
   Low resolution (0.31 m/px) over the playfield, mapped in world space onto the 400 m ground plane.
     R = wetness 0..1  → clearcoat strength (a water film over the asphalt) and albedo darkening
     G = roughness     → 0.85 dry … 0.05 standing water
     B = grime         → tyre tracks / oil, darkens albedo
   Standing water collects at the old puddle spots (now soft-edged), along the quay drain and in the lane gutters;
   damp is a large-scale noise field; dry ground stays dry. */
export const WET_EXTENT = { x0: -80, x1: 80, z0: -70, z1: 60 };
export function wetnessMask(puddles, tracks) {
  const E = WET_EXTENT, PX = 0.3125;
  const W = Math.round((E.x1 - E.x0) / PX), H = Math.round((E.z1 - E.z0) / PX);
  const toX = (x) => (x - E.x0) / PX, toY = (z) => (z - E.z0) / PX;   // row 0 = north (z0)
  const wc = mkCanvas(W, H), wg = wc.getContext('2d');
  // damp field: broad soft blobs
  wg.fillStyle = '#262626'; wg.fillRect(0, 0, W, H);
  for (let i = 0; i < 220; i++) {
    const x = rand() * W, y = rand() * H, r = 20 + rand() * 90, v = 40 + rand() * 90;
    const grd = wg.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${v},${v},${v},.55)`); grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
    wg.fillStyle = grd; wg.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // drain along the quay edge and gutters beside the container columns
  const strip = (x0, z0, x1, z1, v) => {
    wg.fillStyle = `rgba(${v},${v},${v},.7)`;
    wg.fillRect(toX(x0), toY(z0), toX(x1) - toX(x0), toY(z1) - toY(z0));
  };
  strip(-78, -64.6, 78, -63.2, 235);
  strip(-11.2, -58, -10.5, 4, 200); strip(10.5, -58, 11.2, 4, 200);
  // standing water: soft-edged ellipses at the old puddle positions
  for (const p of puddles) {
    wg.save();
    wg.translate(toX(p.x), toY(p.z)); wg.rotate(-p.phi); wg.scale(1, p.sy);
    const r = p.r / PX;
    const grd = wg.createRadialGradient(0, 0, 0, 0, 0, r * 1.35);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.62, 'rgba(255,255,255,.95)');
    grd.addColorStop(0.8, 'rgba(170,170,170,.6)'); grd.addColorStop(1, 'rgba(120,120,120,0)');
    wg.fillStyle = grd; wg.beginPath(); wg.arc(0, 0, r * 1.35, 0, 6.3); wg.fill();
    wg.restore();
  }
  // grime: tyre tracks along the lanes, oil spots where machines stand
  const gc = mkCanvas(W, H), gg = gc.getContext('2d');
  gg.fillStyle = '#000'; gg.fillRect(0, 0, W, H);
  for (const t of tracks) {
    gg.strokeStyle = `rgba(255,255,255,${t.a})`; gg.lineWidth = t.w / PX;
    gg.beginPath(); gg.moveTo(toX(t.x0), toY(t.z0)); gg.lineTo(toX(t.x1), toY(t.z1)); gg.stroke();
  }
  for (let i = 0; i < 60; i++) {
    const x = rand() * W, y = rand() * H, r = 2 + rand() * 6;
    const grd = gg.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    gg.fillStyle = grd; gg.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // pack R = wet, G = roughness, B = grime
  const wd = wg.getImageData(0, 0, W, H).data, gd = gg.getImageData(0, 0, W, H).data;
  const out = mkCanvas(W, H), og = out.getContext('2d'), img = og.createImageData(W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const wet = Math.min(1, wd[i] / 255);
    const rough = 0.85 - (0.85 - 0.05) * Math.pow(wet, 0.7);
    d[i] = wet * 255; d[i + 1] = rough * 255; d[i + 2] = gd[i]; d[i + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  const t = dataTex(out);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;                        // row 0 = north = uv v 0 after the mapping in world.js
  return t;
}

/* ---------------- Fog noise (light shafts) ----------------
   Soft, tileable value noise: a few octaves of blurred blobs, used to make fog drift through the lamp beams. */
export function fogNoiseTexture() {
  const S = 128, c = mkCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
  for (const [n, rMin, rMax, a] of [[40, 18, 40, 0.18], [90, 6, 16, 0.14]]) {
    for (let i = 0; i < n; i++) {
      const x = rand() * S, y = rand() * S, r = rMin + rand() * (rMax - rMin), v = rand() < 0.5 ? 0 : 255;
      wrapped(S, S, x, y, r, (X, Y) => {
        const grd = g.createRadialGradient(X, Y, 0, X, Y, r);
        grd.addColorStop(0, `rgba(${v},${v},${v},${a})`); grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
        g.fillStyle = grd; g.fillRect(X - r, Y - r, r * 2, r * 2);
      });
    }
  }
  const t = dataTex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ---------------- Water (harbour) ripple normal ---------------- */
export function rippleNormal() {
  const S = 256, hc = mkCanvas(S, S), hg = hc.getContext('2d');
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, S, S);
  for (let i = 0; i < 500; i++) {
    const x = rand() * S, y = rand() * S, rx = 6 + rand() * 26, v = rand() < 0.5 ? 0 : 255;
    wrapped(S, S, x, y, rx, (X, Y) => {
      const grd = hg.createRadialGradient(X, Y, 0, X, Y, rx);
      grd.addColorStop(0, `rgba(${v},${v},${v},.18)`); grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
      hg.save(); hg.translate(X, Y); hg.scale(1, 0.35); hg.translate(-X, -Y);
      hg.fillStyle = grd; hg.fillRect(X - rx, Y - rx, rx * 2, rx * 2); hg.restore();
    });
  }
  const t = dataTex(normalFromHeight(hc, 1.4));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export const CONCRETE_TILE_M = 4;
export function concreteTexture() {
  /* Detail map, mean ~0.7 linear: it modulates the vertex colour (which carries the albedo) instead of
     multiplying it down by a second dark albedo. One tile = 4 m × 4 m of wall in world space (128 px/m):
     formwork panel joints every 2 m, tie-rod holes, run-off streaks from the panel tops. */
  const S = 512, c = mkCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#d6d6d4'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 5200; i++) {
    const v = 170 + rand() * 70;
    g.fillStyle = `rgba(${v},${v},${v - 2},${0.16 + rand() * 0.3})`;
    g.fillRect(rand() * S, rand() * S, 1 + rand() * 3, 1 + rand() * 3);
  }
  // run-off streaks: water leaving the top of each formwork panel
  for (let i = 0; i < 70; i++) {
    const x = rand() * S, y0 = Math.floor(rand() * 2) * (S / 2), len = 40 + rand() * 180, w = 2 + rand() * 7;
    const grd = g.createLinearGradient(0, y0, 0, y0 + len);
    grd.addColorStop(0, 'rgba(90,92,94,.28)'); grd.addColorStop(1, 'rgba(90,92,94,0)');
    g.fillStyle = grd; g.fillRect(x, y0, w, len);
  }
  // formwork joints (2 m panels) and tie-rod holes
  g.strokeStyle = 'rgba(70,72,74,.55)'; g.lineWidth = 2;
  for (let i = 0; i <= 2; i++) {
    g.beginPath(); g.moveTo(0, i * S / 2); g.lineTo(S, i * S / 2); g.stroke();
    g.beginPath(); g.moveTo(i * S / 2, 0); g.lineTo(i * S / 2, S); g.stroke();
  }
  for (let px = 0; px < 2; px++) for (let py = 0; py < 2; py++) {
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const x = (px + fx) * S / 2, y = (py + fy) * S / 2;
      g.fillStyle = 'rgba(60,60,62,.7)'; g.beginPath(); g.arc(x, y, 3, 0, 6.3); g.fill();
    }
  }
  const t = toTex(c, [1 / CONCRETE_TILE_M, 1 / CONCRETE_TILE_M]);
  t.anisotropy = 8;
  return t;
}

/* ---------------- Container side panels ----------------
   ISO 40' box, painted corrugated steel. The map is near-white detail multiplied by the vertex colour (the paint);
   UVs are in metres (see world.js), one tile = 3.05 m along the box × the full 2.5 m height (clamped vertically,
   so grime sits on the bottom rail and nowhere else).
   Traces of use: bottom rail scuffed to bare rusted steel by forklift tines, rust bleeding up from the rail and down
   from the top rail, drip streaks, scratches along the panel, a CSC plate. */
export const CONTAINER_SIDE_TILE_M = 3.05;
export const CONTAINER_H_M = 2.5;
export function containerSideSet() {
  const S = 512, c = mkCanvas(S, S), g = c.getContext('2d');
  const hc = mkCanvas(S, S), hg = hc.getContext('2d');
  const RIBS = 11, P = S / RIBS;
  // corrugation: trapezoid profile — flat outer face, sloped flanks, flat inner face
  for (let x = 0; x < S; x++) {
    const t = (x % P) / P;
    const h = t < 0.2 ? 1 : t < 0.35 ? 1 - (t - 0.2) / 0.15 : t < 0.7 ? 0 : t < 0.85 ? (t - 0.7) / 0.15 : 1;
    const v = Math.round(70 + h * 120);
    hg.fillStyle = `rgb(${v},${v},${v})`; hg.fillRect(x, 0, 1, S);
    const shade = 0.88 + h * 0.12;            // a little occlusion in the valleys
    const cv = Math.round(230 * shade);
    g.fillStyle = `rgb(${cv},${cv},${cv - 3})`; g.fillRect(x, 0, 1, S);
  }
  const rail = S * 0.07;                       // ~0.17 m top and bottom rails, flat steel
  // canvas y=0 is the TOP of the box (texture v=1 after flipY)
  g.fillStyle = 'rgb(214,214,210)'; g.fillRect(0, 0, S, rail); g.fillRect(0, S - rail, S, rail);
  hg.fillStyle = 'rgb(200,200,200)'; hg.fillRect(0, 0, S, rail); hg.fillRect(0, S - rail, S, rail);
  // bottom rail: scuffed to bare, rusted steel (warm and darker regardless of the paint)
  for (let i = 0; i < 160; i++) {
    const x = rand() * S, w = 4 + rand() * 40, y = S - rail + rand() * rail * 0.8;
    g.fillStyle = `rgba(${90 + rand() * 40},${55 + rand() * 20},${30 + rand() * 15},${0.35 + rand() * 0.4})`;
    g.fillRect(x, y, w, 1 + rand() * 4);
  }
  // rust bleeding up from the bottom rail and down from the top rail
  for (let i = 0; i < 46; i++) {
    const x = rand() * S, w = 2 + rand() * 6, len = 20 + rand() * 120, top = rand() < 0.35;
    const y0 = top ? rail : S - rail, y1 = top ? rail + len : S - rail - len;
    const grd = g.createLinearGradient(0, y0, 0, y1);
    grd.addColorStop(0, 'rgba(110,62,32,.55)'); grd.addColorStop(1, 'rgba(110,62,32,0)');
    g.fillStyle = grd; g.fillRect(x, Math.min(y0, y1), w, Math.abs(y1 - y0));
  }
  // general grime band low on the panel (splash from the yard)
  const gr = g.createLinearGradient(0, S * 0.62, 0, S);
  gr.addColorStop(0, 'rgba(40,36,30,0)'); gr.addColorStop(1, 'rgba(40,36,30,.35)');
  g.fillStyle = gr; g.fillRect(0, S * 0.62, S, S * 0.38);
  // horizontal scratches (other boxes dragged past)
  g.strokeStyle = 'rgba(150,140,128,.35)'; g.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    const y = S * (0.25 + rand() * 0.6), x = rand() * S, len = 30 + rand() * 140;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (rand() - 0.5) * 6); g.stroke();
  }
  // dents: soft depressions in the height map
  for (let i = 0; i < 6; i++) {
    const x = rand() * S, y = S * (0.2 + rand() * 0.6), r = 14 + rand() * 30;
    const grd = hg.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(0,0,0,.35)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    hg.fillStyle = grd; hg.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const map = toTex(c); map.wrapS = THREE.RepeatWrapping; map.wrapT = THREE.ClampToEdgeWrapping;
  map.repeat.set(1 / CONTAINER_SIDE_TILE_M, 1 / CONTAINER_H_M); map.anisotropy = 8;
  const normalMap = dataTex(normalFromHeight(hc, 3.0));
  normalMap.wrapS = THREE.RepeatWrapping; normalMap.wrapT = THREE.ClampToEdgeWrapping;
  normalMap.repeat.copy(map.repeat); normalMap.anisotropy = 8;
  return { map, normalMap };
}

/* Door end (2.44 m × 2.5 m, one tile, clamped): two leaves, four vertical locking bars with cam keepers and handles,
   four hinge blocks per outer edge, corner posts, door gasket, bottom grime where the doors get kicked open. */
export const CONTAINER_W_M = 2.44;
export function containerEndSet() {
  const S = 512, c = mkCanvas(S, S), g = c.getContext('2d');
  const hc = mkCanvas(S, S), hg = hc.getContext('2d');
  g.fillStyle = 'rgb(226,226,222)'; g.fillRect(0, 0, S, S);
  hg.fillStyle = 'rgb(120,120,120)'; hg.fillRect(0, 0, S, S);
  // shallow horizontal door corrugation
  for (let y = 0; y < S; y++) {
    const t = (y % 46) / 46, h = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    const v = Math.round(100 + h * 50);
    hg.fillStyle = `rgb(${v},${v},${v})`; hg.fillRect(0, y, S, 1);
  }
  const post = S * 0.06;
  // corner posts and header/sill
  g.fillStyle = 'rgb(205,205,200)'; g.fillRect(0, 0, post, S); g.fillRect(S - post, 0, post, S);
  g.fillRect(0, 0, S, post * 0.9); g.fillRect(0, S - post * 0.9, S, post * 0.9);
  hg.fillStyle = 'rgb(210,210,210)'; hg.fillRect(0, 0, post, S); hg.fillRect(S - post, 0, post, S);
  hg.fillRect(0, 0, S, post * 0.9); hg.fillRect(0, S - post * 0.9, S, post * 0.9);
  // door seam and gasket
  g.fillStyle = 'rgba(30,30,30,.85)'; g.fillRect(S / 2 - 2, post, 4, S - post * 2);
  hg.fillStyle = 'rgb(20,20,20)'; hg.fillRect(S / 2 - 3, post, 6, S - post * 2);
  g.strokeStyle = 'rgba(40,40,40,.6)'; g.lineWidth = 3;
  g.strokeRect(post + 4, post + 4, S - post * 2 - 8, S - post * 2 - 8);
  // locking bars: two per leaf, full height, with cam keepers top and bottom and a handle at waist height
  const bars = [0.2, 0.36, 0.64, 0.8];
  for (const fx of bars) {
    const x = fx * S;
    g.fillStyle = 'rgb(150,150,148)'; g.fillRect(x - 4, post * 0.6, 8, S - post * 1.2);
    hg.fillStyle = 'rgb(255,255,255)'; hg.fillRect(x - 4, post * 0.6, 8, S - post * 1.2);
    for (const fy of [0.07, 0.93]) {
      g.fillStyle = 'rgb(120,118,115)'; g.fillRect(x - 10, fy * S - 10, 20, 20);
      hg.fillStyle = 'rgb(240,240,240)'; hg.fillRect(x - 10, fy * S - 10, 20, 20);
    }
    const hy = S * 0.58;
    g.fillStyle = 'rgb(135,133,130)'; g.fillRect(x - 3, hy, fx < 0.5 ? 34 : -34, 7);
    hg.fillStyle = 'rgb(250,250,250)'; hg.fillRect(x - 3, hy, fx < 0.5 ? 34 : -34, 7);
    // rust around the keepers and where hands grab the handle
    for (const fy of [0.07, 0.93, 0.59]) {
      const grd = g.createRadialGradient(x, fy * S, 0, x, fy * S, 26);
      grd.addColorStop(0, 'rgba(110,62,32,.5)'); grd.addColorStop(1, 'rgba(110,62,32,0)');
      g.fillStyle = grd; g.fillRect(x - 26, fy * S - 26, 52, 52);
    }
  }
  // hinge blocks on the outer edges, rust trails running down from each
  for (const fx of [0, 1]) for (const fy of [0.13, 0.38, 0.62, 0.87]) {
    const x = fx ? S - post - 14 : post, y = fy * S;
    g.fillStyle = 'rgb(140,138,134)'; g.fillRect(x, y - 12, 14, 24);
    hg.fillStyle = 'rgb(245,245,245)'; hg.fillRect(x, y - 12, 14, 24);
    const grd = g.createLinearGradient(0, y + 12, 0, y + 70);
    grd.addColorStop(0, 'rgba(105,60,30,.5)'); grd.addColorStop(1, 'rgba(105,60,30,0)');
    g.fillStyle = grd; g.fillRect(x + 3, y + 12, 6, 58);
  }
  // CSC plate on the left leaf
  g.fillStyle = 'rgba(200,196,186,.8)'; g.fillRect(S * 0.08, S * 0.66, 46, 30);
  g.strokeStyle = 'rgba(60,60,60,.6)'; g.lineWidth = 1; g.strokeRect(S * 0.08, S * 0.66, 46, 30);
  // bottom grime: boots and forklift tines
  const gr = g.createLinearGradient(0, S * 0.72, 0, S);
  gr.addColorStop(0, 'rgba(45,38,30,0)'); gr.addColorStop(1, 'rgba(45,38,30,.45)');
  g.fillStyle = gr; g.fillRect(0, S * 0.72, S, S * 0.28);
  const map = toTex(c); map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.repeat.set(1 / CONTAINER_W_M, 1 / CONTAINER_H_M); map.anisotropy = 8;
  const normalMap = dataTex(normalFromHeight(hc, 2.6));
  normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
  normalMap.repeat.copy(map.repeat); normalMap.anisotropy = 8;
  return { map, normalMap };
}

/* ---------------- Ground markings: worn thermoplastic line paint ----------------
   0.4 m × 16 m per tile; alpha carries the wear — tyre-polished gaps, chipped edges, grime. */
export function lineTexture() {
  const W = 64, H = 1024, c = mkCanvas(W, H), g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(226,224,214,.92)'; g.fillRect(3, 0, W - 6, H);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 1400; i++) {
    const x = rand() * W, y = rand() * H, r = 0.5 + rand() * 3;
    g.fillStyle = `rgba(0,0,0,${0.3 + rand() * 0.7})`; g.fillRect(x, y, r, r);
  }
  for (let i = 0; i < 9; i++) {
    const y = rand() * H, len = 20 + rand() * 120;
    const grd = g.createLinearGradient(0, y, 0, y + len);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.5, `rgba(0,0,0,${0.5 + rand() * 0.4})`); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, y, W, len);
  }
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(40,38,34,${rand() * 0.35})`;
    g.fillRect(rand() * W, rand() * H, 1 + rand() * 4, 1 + rand() * 10);
  }
  const t = toTex(c); t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

/* ---------------- Chain-link fence ---------------- */
export function fenceTexture() {
  const c = mkCanvas(128, 128), g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(150,165,175,.85)'; g.lineWidth = 2.6;
  for (let i = -128; i < 256; i += 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke();
    g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke();
  }
  const t = toTex(c, [1, 1]);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ---------------- Building walls (stained) ---------------- */

/* ---------------- Invented brand signage ---------------- */
export function signTexture(main, sub, opts = {}) {
  const w = 1024, h = 256;
  const c = mkCanvas(w, h), g = c.getContext('2d');
  const bg = opts.bg || '#0d1620';
  const fg = opts.fg || '#dfeaf2';
  const accent = opts.accent || '#54d6c6';
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = accent;
  g.fillRect(0, 0, 14, h);
  g.fillRect(0, h - 12, w, 12);
  // corner frame
  g.strokeStyle = accent; g.lineWidth = 4;
  g.strokeRect(34, 34, w - 68, h - 68);
  g.textBaseline = 'middle';
  // main title (fit to width)
  g.fillStyle = fg;
  let size = 84;
  const fit = (text, max, start, weight, family) => {
    let s = start;
    g.font = `${weight} ${s}px ${family}`;
    while (s > 16 && g.measureText(text).width > max) {
      s -= 2;
      g.font = `${weight} ${s}px ${family}`;
    }
    return s;
  };
  size = fit(main, w - 130, 84, 'bold', '"Helvetica Neue", Arial, sans-serif');
  g.fillText(main, 66, h / 2 - 14);
  // subtitle
  g.fillStyle = accent;
  fit(sub || '', w - 300, 30, '500', '"SF Mono", Menlo, monospace');
  g.fillText(sub || '', 68, h / 2 + 62);
  // code
  g.fillStyle = 'rgba(220,235,245,.35)';
  g.font = '500 24px "SF Mono", Menlo, monospace';
  g.fillText(opts.code || 'MPA-03', w - 210, h / 2 + 62);
  // wear
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(0,0,0,${rand() * 0.28})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 6, 1 + rand() * 4);
  }
  return toTex(c);
}

/* ---------------- Container numbers ---------------- */
export function containerCodeTexture(color, code) {
  /* Lettering only (transparent elsewhere) so the corrugation and grime of the side panel show through;
     stencilled paint, slightly worn. `color` is unused now and kept for call compatibility. */
  void color;
  const c = mkCanvas(512, 256), g = c.getContext('2d');
  g.clearRect(0, 0, 512, 256);
  g.fillStyle = 'rgba(236,238,236,.9)';
  g.font = 'bold 92px "SF Mono", Menlo, monospace';
  g.fillText(code, 34, 128);
  g.font = '500 34px "SF Mono", Menlo, monospace';
  g.fillText('KRG-9 CARGO', 36, 196);
  g.fillText('22G1', 420, 196);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(0,0,0,${0.3 + rand() * 0.6})`;
    g.fillRect(rand() * 512, rand() * 256, 1 + rand() * 3, 1 + rand() * 3);
  }
  g.globalCompositeOperation = 'source-over';
  return toTex(c);
}

/* ---------------- Gate / warning ---------------- */

/* ---------------- Portholes / deck lights ---------------- */
export function shipHullTexture() {
  /* the hull is only ever seen 40+ m away through fog: 512 × 128 is plenty (textures are sized by viewing distance) */
  const c = mkCanvas(512, 128), g = c.getContext('2d');
  g.scale(0.5, 0.5);
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#1d242c');
  grd.addColorStop(0.55, '#131920');
  grd.addColorStop(1, '#0c1116');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 256);
  // portholes
  for (let i = 0; i < 22; i++) {
    const lit = rand() < 0.55;
    g.fillStyle = lit ? 'rgba(255,214,150,.85)' : 'rgba(60,80,95,.5)';
    g.fillRect(40 + i * 44, 96, 20, 13);
  }
  return toTex(c);
}
