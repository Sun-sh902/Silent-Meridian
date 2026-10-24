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
export function asphaltTexture() {
  /* Weathered asphalt, albedo ~0.05–0.07 linear (sRGB ~60–70) with aggregate speckle.
     The old base (#14181d, ~0.007 linear) was an order of magnitude too dark, so no light could resolve it. */
  const c = mkCanvas(512, 512), g = c.getContext('2d');
  g.fillStyle = '#3c3e41'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 44 + rand() * 40;
    g.fillStyle = `rgba(${v},${v + 1},${v + 3},${0.25 + rand() * 0.4})`;
    g.fillRect(rand() * 512, rand() * 512, 1 + rand() * 2, 1 + rand() * 2);
  }
  // damp patches (darker where water has soaked in)
  for (let i = 0; i < 40; i++) {
    const x = rand() * 512, y = rand() * 512, r = 20 + rand() * 90;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(14,16,18,.35)');
    grd.addColorStop(1, 'rgba(14,16,18,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
  }
  return toTex(c, [14, 14]);
}

export function concreteTexture() {
  /* Detail map, mean ~0.7 linear: it modulates the vertex colour (which carries the albedo) instead of
     multiplying it down by a second dark albedo. */
  const c = mkCanvas(512, 512), g = c.getContext('2d');
  g.fillStyle = '#d6d6d4'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5200; i++) {
    const v = 170 + rand() * 70;
    g.fillStyle = `rgba(${v},${v},${v - 2},${0.16 + rand() * 0.3})`;
    g.fillRect(rand() * 512, rand() * 512, 1 + rand() * 3, 1 + rand() * 3);
  }
  // formwork joints
  g.strokeStyle = 'rgba(70,72,74,.55)'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(0, i * 128); g.lineTo(512, i * 128); g.stroke();
    g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 512); g.stroke();
  }
  return toTex(c, [6, 6]);
}

/* ---------------- Container side panels ---------------- */

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
  const c = mkCanvas(512, 256), g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 512, 256);
  for (let x = 0; x < 512; x += 32) {
    g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(x, 0, 14, 256);
    g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(x + 14, 0, 3, 256);
  }
  for (let i = 0; i < 240; i++) {
    const x = rand() * 512, y = rand() * 256, r = 2 + rand() * 14;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(90,50,25,.26)');
    grd.addColorStop(1, 'rgba(90,50,25,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
  }
  g.fillStyle = 'rgba(240,248,252,.72)';
  g.font = 'bold 92px "SF Mono", Menlo, monospace';
  g.fillText(code, 34, 128);
  g.font = '500 34px "SF Mono", Menlo, monospace';
  g.fillText('KRG-9 CARGO', 36, 196);
  g.fillText('22G1', 420, 196);
  return toTex(c);
}

/* ---------------- Gate / warning ---------------- */

/* ---------------- Portholes / deck lights ---------------- */
export function shipHullTexture() {
  const c = mkCanvas(1024, 256), g = c.getContext('2d');
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
