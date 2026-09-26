/* ============================================================
   textures.js — 程序化画布贴图（原创虚构标识 / 材质细节）
   ============================================================ */
import * as THREE from 'three';

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

/* ---------------- 混凝土 / 沥青 ---------------- */
export function asphaltTexture() {
  const c = mkCanvas(512, 512), g = c.getContext('2d');
  g.fillStyle = '#14181d'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 18 + Math.random() * 26;
    g.fillStyle = `rgba(${v + 8},${v + 10},${v + 14},${0.25 + Math.random() * 0.4})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // 湿痕
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 512, y = Math.random() * 512, r = 20 + Math.random() * 90;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(6,10,14,.5)');
    grd.addColorStop(1, 'rgba(6,10,14,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
  }
  return toTex(c, [14, 14]);
}

export function concreteTexture() {
  const c = mkCanvas(512, 512), g = c.getContext('2d');
  g.fillStyle = '#232830'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5200; i++) {
    const v = 30 + Math.random() * 30;
    g.fillStyle = `rgba(${v},${v + 3},${v + 7},${0.16 + Math.random() * 0.3})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // 模板接缝
  g.strokeStyle = 'rgba(10,12,16,.55)'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(0, i * 128); g.lineTo(512, i * 128); g.stroke();
    g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 512); g.stroke();
  }
  return toTex(c, [6, 6]);
}

/* ---------------- 集装箱侧板 ---------------- */
export function containerTexture(color = '#3d5a52') {
  const c = mkCanvas(256, 256), g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 256, 256);
  // 波纹
  for (let x = 0; x < 256; x += 16) {
    const shade = 0.10 + 0.16 * Math.abs(Math.sin(x * 0.4));
    g.fillStyle = `rgba(0,0,0,${shade})`;
    g.fillRect(x, 0, 8, 256);
    g.fillStyle = 'rgba(255,255,255,.045)';
    g.fillRect(x + 8, 0, 2, 256);
  }
  // 锈迹
  for (let i = 0; i < 130; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const r = 2 + Math.random() * 12;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${70 + Math.random() * 40},${40 + Math.random() * 20},20,.30)`);
    grd.addColorStop(1, 'rgba(70,40,20,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
  }
  return toTex(c, [1, 1]);
}

/* ---------------- 铁丝网 ---------------- */
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

/* ---------------- 建筑墙面（带污渍） ---------------- */
export function wallTexture(base = '#2f3742') {
  const c = mkCanvas(256, 256), g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = Math.random() * 40;
    g.fillStyle = `rgba(${20 + v},${24 + v},${30 + v},${0.05 + Math.random() * 0.18})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // 水渍条纹
  for (let i = 0; i < 22; i++) {
    const x = Math.random() * 256, w = 3 + Math.random() * 16;
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, 'rgba(8,10,14,.32)');
    grd.addColorStop(1, 'rgba(8,10,14,0)');
    g.fillStyle = grd; g.fillRect(x, 0, w, 256);
  }
  return toTex(c, [4, 4]);
}

/* ---------------- 虚构品牌招牌 ---------------- */
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
  // 角标
  g.strokeStyle = accent; g.lineWidth = 4;
  g.strokeRect(34, 34, w - 68, h - 68);
  g.textBaseline = 'middle';
  // 主标题（自适应宽度）
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
  // 副标题
  g.fillStyle = accent;
  fit(sub || '', w - 300, 30, '500', '"SF Mono", Menlo, monospace');
  g.fillText(sub || '', 68, h / 2 + 62);
  // 编号
  g.fillStyle = 'rgba(220,235,245,.35)';
  g.font = '500 24px "SF Mono", Menlo, monospace';
  g.fillText(opts.code || 'MPA-03', w - 210, h / 2 + 62);
  // 磨损
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.28})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 6, 1 + Math.random() * 4);
  }
  return toTex(c);
}

/* ---------------- 集装箱编号 ---------------- */
export function containerCodeTexture(color, code) {
  const c = mkCanvas(512, 256), g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 512, 256);
  for (let x = 0; x < 512; x += 32) {
    g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(x, 0, 14, 256);
    g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(x + 14, 0, 3, 256);
  }
  for (let i = 0; i < 240; i++) {
    const x = Math.random() * 512, y = Math.random() * 256, r = 2 + Math.random() * 14;
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

/* ---------------- 门禁 / 警示 ---------------- */
export function hazardTexture() {
  const c = mkCanvas(256, 64), g = c.getContext('2d');
  g.fillStyle = '#1a1c20'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#e8c247';
  for (let i = -64; i < 320; i += 42) {
    g.beginPath();
    g.moveTo(i, 64); g.lineTo(i + 21, 64); g.lineTo(i + 21 + 64, 0); g.lineTo(i + 64, 0);
    g.closePath(); g.fill();
  }
  return toTex(c, [1, 1]);
}

/* ---------------- 舱窗 / 舷灯 ---------------- */
export function shipHullTexture() {
  const c = mkCanvas(1024, 256), g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#1d242c');
  grd.addColorStop(0.55, '#131920');
  grd.addColorStop(1, '#0c1116');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 256);
  // 舷窗
  for (let i = 0; i < 22; i++) {
    const lit = Math.random() < 0.55;
    g.fillStyle = lit ? 'rgba(255,214,150,.85)' : 'rgba(60,80,95,.5)';
    g.fillRect(40 + i * 44, 96, 20, 13);
  }
  return toTex(c);
}
