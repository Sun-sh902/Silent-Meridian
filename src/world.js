/* ============================================================
   world.js — 原创港区布局 / 光照 / 雨夜氛围
   坐标：X 向东，-Z 向北（码头方向），+Y 向上，单位米
   ============================================================ */
import * as THREE from 'three';
import { Grid } from './geom.js';
import { makeRng } from './geom.js';
import * as TX from './textures.js';

export const WORLD = {
  waterZ: -66,
  gate: { z: 50, halfWidth: 7 },
  bounds: { x0: -72, x1: 72, z0: -66, z1: 50 },
};

/* ============================================================
   几何批处理器：把大量静态盒体合并成少量网格
   ============================================================ */
const _nonIndexedCache = new WeakMap();
function nonIndexed(g) {
  if (!g.index) return g;
  let c = _nonIndexedCache.get(g);
  if (!c) { c = g.toNonIndexed(); _nonIndexedCache.set(g, c); }
  return c;
}

class Batcher {
  constructor() { this.b = new Map(); }
  _b(name) {
    let o = this.b.get(name);
    if (!o) this.b.set(name, (o = { pos: [], nor: [], col: [], uv: [] }));
    return o;
  }
  add(name, geo, matrix, color) {
    const src = nonIndexed(geo);
    const p = src.attributes.position.array;
    const n = src.attributes.normal.array;
    const u = src.attributes.uv ? src.attributes.uv.array : null;
    const o = this._b(name);
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const v = new THREE.Vector3(), vn = new THREE.Vector3();
    const c = new THREE.Color(color);
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(matrix);
      vn.set(n[i], n[i + 1], n[i + 2]).applyMatrix3(nm).normalize();
      o.pos.push(v.x, v.y, v.z);
      o.nor.push(vn.x, vn.y, vn.z);
      o.col.push(c.r, c.g, c.b);
    }
    if (u) o.uv.push(...u); else for (let i = 0; i < p.length / 3; i++) o.uv.push(0, 0);
  }
  build(materials, parent, castShadow = true, receiveShadow = true) {
    const out = [];
    for (const [name, o] of this.b) {
      if (!o.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(o.nor, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(o.col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, materials[name]);
      m.castShadow = castShadow;
      m.receiveShadow = receiveShadow;
      m.name = 'batch-' + name;
      parent.add(m);
      out.push(m);
    }
    return out;
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
const UNIT_CYL_LO = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);

/* ============================================================
   Level：同时产出几何体与碰撞体
   ============================================================ */
class Level {
  constructor(scene, grid) {
    this.scene = scene;
    this.grid = grid;
    this.batch = new Batcher();
    this.rng = makeRng(20260924);
    this.signs = [];
    this.covers = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  /** 以「边界」方式添加盒体 + 碰撞 */
  box(x0, x1, y0, y1, z0, z1, o = {}) {
    const bucket = o.bucket || 'concrete';
    const color = o.color !== undefined ? o.color : 0x39404a;
    if (o.visible !== false) {
      this._v.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      this._s.set(Math.abs(x1 - x0) || 0.02, Math.abs(y1 - y0) || 0.02, Math.abs(z1 - z0) || 0.02);
      this._m.compose(this._v, new THREE.Quaternion(), this._s);
      this.batch.add(bucket, UNIT_BOX, this._m, color);
    }
    if (o.collide !== false) {
      this.grid.add({
        min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
        max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
        tag: o.tag || 'structure',
        opaque: o.opaque !== false,
      });
    }
    return this;
  }

  /** 带旋转的盒体（集装箱、道具） */
  rotBox(cx, cy, cz, sx, sy, sz, ry, o = {}) {
    const bucket = o.bucket || 'paint';
    const color = o.color !== undefined ? o.color : 0x445a52;
    this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    this._v.set(cx, cy, cz);
    this._s.set(sx, sy, sz);
    this._m.compose(this._v, this._q, this._s);
    this.batch.add(bucket, UNIT_BOX, this._m, color);
    if (o.collide !== false) {
      const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
      const ex = (sx * c + sz * s) / 2;
      const ez = (sx * s + sz * c) / 2;
      this.grid.add({
        min: { x: cx - ex, y: cy - sy / 2, z: cz - ez },
        max: { x: cx + ex, y: cy + sy / 2, z: cz + ez },
        tag: o.tag || 'prop',
        opaque: o.opaque !== false,
      });
    }
    return this;
  }

  cyl(cx, cy, cz, r, h, o = {}) {
    const bucket = o.bucket || 'metal';
    const color = o.color !== undefined ? o.color : 0x5a636c;
    this._q.identity();
    this._v.set(cx, cy, cz);
    this._s.set(r * 2, h, r * 2);
    this._m.compose(this._v, this._q, this._s);
    this.batch.add(bucket, o.lowPoly ? UNIT_CYL_LO : UNIT_CYL, this._m, color);
    if (o.collide) {
      this.grid.add({
        min: { x: cx - r, y: cy - h / 2, z: cz - r },
        max: { x: cx + r, y: cy + h / 2, z: cz + r },
        tag: o.tag || 'prop', opaque: o.opaque !== false,
      });
    }
    return this;
  }

  /**
   * 沿 Z 轴延伸的墙（位于常量 x 处），可带门/窗开口。
   * openings: [{from,to,sill,head,glass}] —— from/to 为 z 坐标
   */
  wallX(xc, thick, z0, z1, y0, y1, openings, color, opts = {}) {
    const list = (openings || []).slice().sort((a, b) => a.from - b.from);
    let cur = Math.min(z0, z1);
    const end = Math.max(z0, z1);
    for (const o of list) {
      if (o.from > cur) this.box(xc - thick / 2, xc + thick / 2, y0, y1, cur, o.from, { color, ...opts });
      if (o.sill > y0) this.box(xc - thick / 2, xc + thick / 2, y0, o.sill, o.from, o.to, { color, ...opts });
      if (y1 > o.head) this.box(xc - thick / 2, xc + thick / 2, o.head, y1, o.from, o.to, { color, ...opts });
      if (o.glass !== false) {
        this.box(xc - 0.05, xc + 0.05, o.sill, o.head, o.from + 0.02, o.to - 0.02,
          { bucket: 'glass', collide: true, opaque: false, tag: 'glass' });
      }
      cur = o.to;
    }
    if (cur < end) this.box(xc - thick / 2, xc + thick / 2, y0, y1, cur, end, { color, ...opts });
    return this;
  }

  /** 沿 X 轴延伸的墙（位于常量 z 处） */
  wallZ(zc, thick, x0, x1, y0, y1, openings, color, opts = {}) {
    const list = (openings || []).slice().sort((a, b) => a.from - b.from);
    let cur = Math.min(x0, x1);
    const end = Math.max(x0, x1);
    for (const o of list) {
      if (o.from > cur) this.box(cur, o.from, y0, y1, zc - thick / 2, zc + thick / 2, { color, ...opts });
      if (o.sill > y0) this.box(o.from, o.to, y0, o.sill, zc - thick / 2, zc + thick / 2, { color, ...opts });
      if (y1 > o.head) this.box(o.from, o.to, o.head, y1, zc - thick / 2, zc + thick / 2, { color, ...opts });
      if (o.glass !== false) {
        this.box(o.from + 0.02, o.to - 0.02, o.sill, o.head, zc - 0.05, zc + 0.05,
          { bucket: 'glass', collide: true, opaque: false, tag: 'glass' });
      }
      cur = o.to;
    }
    if (cur < end) this.box(cur, end, y0, y1, zc - thick / 2, zc + thick / 2, { color, ...opts });
    return this;
  }

  sign(text, sub, x, y, z, w, h, ry, opts = {}) {
    const tex = TX.signTexture(text, sub, opts);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissive: new THREE.Color(opts.emissive || 0x2a3b46),
      emissiveMap: tex, emissiveIntensity: opts.glow === false ? 0.25 : 0.75,
      roughness: 0.6, metalness: 0.2,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    this.scene.add(m);
    this.signs.push(m);
    return m;
  }
}

/* ============================================================
   环境贴图（湿反射来源）
   ============================================================ */
function buildEnvironment(renderer) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.00, '#0a1622');
  grd.addColorStop(0.42, '#12283a');
  grd.addColorStop(0.52, '#1b3b4e');
  grd.addColorStop(0.68, '#0d1a22');
  grd.addColorStop(1.00, '#05080b');
  g.fillStyle = grd; g.fillRect(0, 0, 512, 256);
  // 地平线灯带 + 灯点
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 512, y = 118 + Math.random() * 22;
    const r = 8 + Math.random() * 22;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(255,196,128,.85)');
    rg.addColorStop(1, 'rgba(255,180,110,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = 'rgba(255,255,255,.5)';
    g.fillRect(Math.random() * 512, Math.random() * 40, 1.4, 1.4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt.texture;
}

/* 夜空渐变（等距圆柱背景） */
function buildSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0.00, '#04070b');
  grd.addColorStop(0.28, '#071019');
  grd.addColorStop(0.44, '#091420');
  grd.addColorStop(0.50, '#0f2130');
  grd.addColorStop(0.53, '#152b36');
  grd.addColorStop(0.58, '#0a131b');
  grd.addColorStop(0.72, '#070c12');
  grd.addColorStop(1.00, '#04070a');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 512);
  // 云层
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 1024, y = 120 + Math.random() * 180;
    const rx = 120 + Math.random() * 260, ry = 22 + Math.random() * 46;
    const rg = g.createRadialGradient(x, y, 0, x, y, rx);
    rg.addColorStop(0, `rgba(28,48,64,${0.07 + Math.random() * 0.11})`);
    rg.addColorStop(1, 'rgba(20,36,50,0)');
    g.save(); g.translate(x, y); g.scale(1, ry / rx); g.translate(-x, -y);
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, rx, 0, 6.3); g.fill();
    g.restore();
  }
  // 港口光污染
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 1024, y = 268 + Math.random() * 20;
    const r = 40 + Math.random() * 120;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(255,170,100,.085)');
    rg.addColorStop(1, 'rgba(255,150,80,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ============================================================
   雨
   ============================================================ */
function buildRain(scene, count = 5200, area = 74, height = 34) {
  const pos = new Float32Array(count * 2 * 3);
  const top = new Float32Array(count * 2);
  const spd = new Float32Array(count * 2);
  const rnd = makeRng(7);
  for (let i = 0; i < count; i++) {
    const x = (rnd.next() - 0.5) * area;
    const z = (rnd.next() - 0.5) * area;
    const y = rnd.next() * height;
    const s = 0.72 + rnd.next() * 0.62;
    for (let k = 0; k < 2; k++) {
      const j = (i * 2 + k) * 3;
      pos[j] = x; pos[j + 1] = y; pos[j + 2] = z;
      top[i * 2 + k] = k;
      spd[i * 2 + k] = s;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aTop', new THREE.BufferAttribute(top, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(spd, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), area);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uH: { value: height },
      uLen: { value: 1.35 },
      uWind: { value: new THREE.Vector2(-0.16, 0.05) },
      uColor: { value: new THREE.Color(0xdcecf8) },
      uOpacity: { value: 0.34 },
    },
    vertexShader: /* glsl */`
      attribute float aTop;
      attribute float aSpeed;
      uniform float uTime, uH, uLen;
      uniform vec2 uWind;
      varying float vFade;
      void main(){
        vec3 p = position;
        float fall = uTime * 26.0 * aSpeed;
        p.y = mod(p.y - fall, uH);
        float len = uLen * (0.55 + aSpeed * 0.75);
        p.x += aTop * uWind.x * len;
        p.z += aTop * uWind.y * len;
        p.y += aTop * len;
        vFade = 1.0 - smoothstep(0.0, uH, p.y) * 0.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vFade = clamp(1.0 - (-mv.z) / 78.0, 0.05, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity;
      varying float vFade;
      void main(){
        gl_FragColor = vec4(uColor, uOpacity * vFade);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 6;
  scene.add(lines);
  return { mesh: lines, mat, height, area };
}

/* ============================================================
   灯光
   ============================================================ */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,224,178,.95)');
  grd.addColorStop(0.25, 'rgba(255,198,126,.42)');
  grd.addColorStop(1, 'rgba(255,180,110,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ============================================================
   构建世界
   ============================================================ */
export function buildWorld(scene, renderer) {
  const grid = new Grid(8);
  const L = new Level(scene, grid);
  const rng = L.rng;

  scene.fog = new THREE.FogExp2(0x0a141d, 0.0158);
  scene.background = buildSkyTexture();
  scene.environment = buildEnvironment(renderer);

  /* ---------------- 材质 ---------------- */
  const asphalt = TX.asphaltTexture();
  asphalt.wrapS = asphalt.wrapT = THREE.RepeatWrapping;
  const mats = {
    asphalt: new THREE.MeshStandardMaterial({
      map: asphalt, color: 0xffffff, roughness: 0.34, metalness: 0.62, envMapIntensity: 0.85,
    }),
    water: new THREE.MeshStandardMaterial({
      color: 0x03070b, roughness: 0.26, metalness: 0.95, envMapIntensity: 0.5,
    }),
    concrete: new THREE.MeshStandardMaterial({
      map: TX.concreteTexture(), vertexColors: true, roughness: 0.78, metalness: 0.08, envMapIntensity: 0.55,
    }),
    metal: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.36, metalness: 0.88, envMapIntensity: 0.9,
    }),
    paint: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.55, metalness: 0.3, envMapIntensity: 0.7,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x9fd4e2, transparent: true, opacity: 0.16, roughness: 0.06,
      metalness: 0.35, side: THREE.DoubleSide, envMapIntensity: 1.6, depthWrite: false,
    }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xffe3b8, emissive: 0xffb46b, emissiveIntensity: 1.35,
      roughness: 0.35, metalness: 0.1,
    }),
  };
  mats.concrete.map.wrapS = mats.concrete.map.wrapT = THREE.RepeatWrapping;

  /* ---------------- 地面 / 水面 ---------------- */
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mats.asphalt);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.position.y = 0;
  scene.add(ground);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(520, 260), mats.water);
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -1.5, WORLD.waterZ - 130);
  scene.add(water);

  /* ---------------- 码头边缘 ---------------- */
  L.box(-80, 80, -1.6, 0.02, WORLD.waterZ - 2.2, WORLD.waterZ, { color: 0x2b3138, bucket: 'concrete' });
  L.box(-80, 80, 0.0, 0.5, WORLD.waterZ - 0.2, WORLD.waterZ + 0.9, { color: 0x3a424c, bucket: 'concrete' });
  for (let x = -76; x <= 76; x += 9) {
    L.cyl(x, 0.62, WORLD.waterZ + 0.4, 0.42, 0.62, { color: 0x2f353c, collide: false, lowPoly: true });
    L.cyl(x, 1.05, WORLD.waterZ + 0.4, 0.19, 0.5, { color: 0x50585f, collide: false, lowPoly: true });
  }
  // 护舷
  for (let x = -70; x <= 70; x += 16) {
    L.cyl(x, -0.4, WORLD.waterZ - 0.35, 0.5, 1.5, { color: 0x15181c, collide: false, lowPoly: true });
  }

  /* ---------------- 围栏 ---------------- */
  const fenceMat = new THREE.MeshStandardMaterial({
    map: TX.fenceTexture(), transparent: true, alphaTest: 0.28, side: THREE.DoubleSide,
    color: 0x8b98a4, metalness: 0.7, roughness: 0.5, depthWrite: true,
  });
  fenceMat.map.repeat.set(1, 1);
  const addFence = (x0, z0, x1, z1) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const g = new THREE.PlaneGeometry(len, 3.3);
    const t = fenceMat.clone();
    t.map = fenceMat.map.clone();
    t.map.needsUpdate = true;
    t.map.wrapS = t.map.wrapT = THREE.RepeatWrapping;
    t.map.repeat.set(len / 2.4, 1.375);
    const m = new THREE.Mesh(g, t);
    m.position.set((x0 + x1) / 2, 1.65, (z0 + z1) / 2);
    m.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
    scene.add(m);
    // 立柱
    const n = Math.max(2, Math.round(len / 4));
    for (let i = 0; i <= n; i++) {
      const t2 = i / n;
      L.cyl(x0 + dx * t2, 1.7, z0 + dz * t2, 0.075, 3.4, { color: 0x6a737c, collide: false, lowPoly: true });
    }
    const steps = Math.ceil(len / 4);
    for (let i = 0; i <= steps; i++) {
      const t2 = i / steps;
      grid.add({
        min: { x: Math.min(x0 + dx * t2, x0 + dx * (t2 + 1 / steps)) - 0.3, y: 0, z: Math.min(z0 + dz * t2, z0 + dz * (t2 + 1 / steps)) - 0.3 },
        max: { x: Math.max(x0 + dx * t2, x0 + dx * (t2 + 1 / steps)) + 0.3, y: 3.3, z: Math.max(z0 + dz * t2, z0 + dz * (t2 + 1 / steps)) + 0.3 },
        tag: 'fence', opaque: false,
      });
    }
  };
  addFence(-72, 50, -WORLD.gate.halfWidth, 50);
  addFence(WORLD.gate.halfWidth, 50, 72, 50);
  addFence(-72, -66, -72, 50);
  addFence(72, -66, 72, 50);

  /* ---------------- 三号仓 BAY 3 ---------------- */
  const whA = { x0: -64, x1: -20, z0: -26, z1: 4, h: 9.5 };
  const wallC = 0x333a45;
  // 地面
  L.box(whA.x0, whA.x1, 0.0, 0.14, whA.z0, whA.z1, { color: 0x2c333c, bucket: 'concrete', collide: false });
  // 四面墙：西墙完整，东墙留两处货门，南墙留出入门
  L.wallX(whA.x0 + 0.3, 0.6, whA.z0, whA.z1, 0, whA.h, [], wallC);
  L.wallX(whA.x1 - 0.3, 0.6, whA.z0, whA.z1, 0, whA.h, [
    { from: -22.4, to: -16.0, sill: 0, head: 6.4, glass: false },
    { from: -8.4, to: -2.0, sill: 0, head: 6.4, glass: false },
  ], wallC);
  L.wallZ(whA.z0 + 0.3, 0.6, whA.x0, whA.x1, 0, whA.h, [], wallC);
  L.wallZ(whA.z1 - 0.3, 0.6, whA.x0, whA.x1, 0, whA.h, [
    { from: -40.4, to: -36.6, sill: 0, head: 3.0, glass: false },
  ], wallC);
  // 屋顶
  L.box(whA.x0 - 0.4, whA.x1 + 0.4, whA.h, whA.h + 0.5, whA.z0 - 0.4, whA.z1 + 0.4,
    { color: 0x252b33, bucket: 'metal' });

  // 内部立柱
  for (let z = whA.z0 + 5; z < whA.z1 - 2; z += 6) {
    L.box(-42.5, -41.5, 0, whA.h - 0.6, z - 0.5, z + 0.5, { color: 0x3b434e, bucket: 'concrete' });
  }
  // 货架
  for (let i = 0; i < 5; i++) {
    const z = -22 + i * 5.5;
    L.box(-62, -52, 0, 3.6, z, z + 1.6, { color: 0x4a5158, bucket: 'metal' });
    L.box(-50, -44, 0, 3.6, z, z + 1.6, { color: 0x4a5158, bucket: 'metal' });
    L.box(-42, -38.5, 0, 2.4, z + 1.0, z + 2.4, { color: 0x4d4438, bucket: 'paint' });
  }
  // 三号仓办公室（东北角，内含货单）
  const off = { x0: -34, x1: -21.2, z0: -25.4, z1: -17.4 };
  L.box(off.x0, off.x1, 0, 0.12, off.z0, off.z1, { color: 0x3a4149, bucket: 'concrete', collide: false });
  const offC = 0x3d4650;
  L.wallX(off.x0 - 0.125, 0.25, off.z0, off.z1, 0, 3.0,
    [{ from: off.z0 + 1.8, to: off.z0 + 5.6, sill: 1.35, head: 2.5, glass: true }], offC);
  L.wallX(off.x1 + 0.125, 0.25, off.z0, off.z1, 0, 3.0, [], offC);
  L.wallZ(off.z0 - 0.125, 0.25, off.x0, off.x1, 0, 3.0, [], offC);
  L.wallZ(off.z1 + 0.125, 0.25, off.x0, off.x1, 0, 3.0,
    [{ from: -30.4, to: -28.6, sill: 0, head: 2.2, glass: false }], offC);
  L.box(off.x0 - 0.3, off.x1 + 0.3, 3.0, 3.25, off.z0 - 0.3, off.z1 + 0.3, { color: 0x333a42, collide: false });
  // 办公室内：桌子、柜子、白板
  L.box(-32.6, -30.2, 0, 0.78, -24.4, -22.6, { color: 0x5a4a37, bucket: 'paint' });
  L.box(-32.6, -30.2, 0.78, 0.84, -24.6, -22.4, { color: 0x6b5842, bucket: 'paint', collide: false });
  L.box(-24.4, -23.0, 0, 1.9, -25.0, -23.4, { color: 0x4b5560, bucket: 'metal' });
  L.box(-31.0, -28.4, 1.1, 2.0, -25.2, -25.0, { color: 0xd8dde2, bucket: 'paint', collide: false });
  L.cyl(-25.6, 0.3, -19.4, 0.32, 0.6, { color: 0x2f363d, collide: true, lowPoly: true });
  // 招牌
  L.sign('VOLKERSTADT LOGISTIK', 'BAY 3 · GENERAL CARGO', -20.1, 7.2, -11, 12, 3, Math.PI / 2, { code: 'MPA-03' });
  L.sign('三号仓', 'BAY 3', -20.2, 4.6, 1.6, 6, 1.5, Math.PI / 2, { accent: '#e8c247', code: 'ENT-3B' });

  /* ---------------- 冷库 KÜHLHAUS ---------------- */
  const whB = { x0: 18, x1: 62, z0: 6, z1: 40, h: 8 };
  L.box(whB.x0, whB.x1, 0, 0.14, whB.z0, whB.z1, { color: 0x2a3138, bucket: 'concrete', collide: false });
  const whBC = 0x39424c;
  L.wallX(whB.x0 + 0.3, 0.6, whB.z0, whB.z1, 0, whB.h,
    [{ from: 18.5, to: 23.5, sill: 0, head: 3.2, glass: false }], whBC);
  L.wallX(whB.x1 - 0.3, 0.6, whB.z0, whB.z1, 0, whB.h, [], whBC);
  L.wallZ(whB.z0 + 0.3, 0.6, whB.x0, whB.x1, 0, whB.h,
    [{ from: 33.5, to: 38.5, sill: 0, head: 3.2, glass: false }], whBC);
  L.wallZ(whB.z1 - 0.3, 0.6, whB.x0, whB.x1, 0, whB.h, [], whBC);
  L.box(whB.x0 - 0.4, whB.x1 + 0.4, whB.h, whB.h + 0.6, whB.z0 - 0.4, whB.z1 + 0.4, { color: 0x20262d, bucket: 'metal' });
  // 冷库内货架与托盘
  for (let i = 0; i < 4; i++) {
    const z = 12 + i * 7;
    L.box(30, 44, 0, 4.2, z, z + 1.8, { color: 0x515a63, bucket: 'metal' });
    L.box(46, 58, 0, 4.2, z, z + 1.8, { color: 0x515a63, bucket: 'metal' });
  }
  L.sign('EISWERK KÜHLHAUS', 'COLD STORE · 冷库', 17.7, 6.2, 12, 11, 2.8, -Math.PI / 2, { code: 'CS-2', accent: '#7fd6ff' });

  /* ---------------- 调度楼 DISPATCH ---------------- */
  const dp = { x0: 22, x1: 54, z0: -42, z1: -20, h: 6.6 };
  L.box(dp.x0, dp.x1, 0, 0.16, dp.z0, dp.z1, { color: 0x2f363e, bucket: 'concrete', collide: false });
  const dpC = 0x3c4550;
  // 西立面：面向堆场，开窗以便外部观察
  L.wallX(dp.x0 + 0.25, 0.5, dp.z0, dp.z1, 0, dp.h, [
    { from: -38.6, to: -34.6, sill: 1.3, head: 3.2, glass: true },
    { from: -30.2, to: -26.2, sill: 1.3, head: 3.2, glass: true },
    { from: -25.0, to: -22.0, sill: 1.3, head: 3.2, glass: true },
  ], dpC);
  L.wallX(dp.x1 - 0.25, 0.5, dp.z0, dp.z1, 0, dp.h, [
    { from: -38.6, to: -34.6, sill: 1.3, head: 3.2, glass: true },
    { from: -30.2, to: -26.2, sill: 1.3, head: 3.2, glass: true },
  ], dpC);
  L.wallZ(dp.z0 + 0.25, 0.5, dp.x0, dp.x1, 0, dp.h, [], dpC);
  // 南立面：主入口 + 连排窗
  L.wallZ(dp.z1 - 0.25, 0.5, dp.x0, dp.x1, 0, dp.h, [
    { from: 25.6, to: 29.6, sill: 0, head: 3.0, glass: false },
    { from: 31.6, to: 36.6, sill: 1.3, head: 3.2, glass: true },
    { from: 40.4, to: 45.4, sill: 1.3, head: 3.2, glass: true },
    { from: 47.4, to: 52.4, sill: 1.3, head: 3.2, glass: true },
  ], dpC);
  L.box(dp.x0 - 0.35, dp.x1 + 0.35, dp.h, dp.h + 0.45, dp.z0 - 0.35, dp.z1 + 0.35, { color: 0x272d35, bucket: 'metal' });
  // 内部隔墙（西：行政 / 东：调度室）
  L.wallX(38.7, 0.6, dp.z0 + 0.5, dp.z1 - 0.5, 0, dp.h - 0.6,
    [{ from: -31.4, to: -28.6, sill: 0, head: 2.4, glass: false }], 0x363f49);
  // 调度室内部
  L.box(41, 46, 0, 0.86, -34.5, -32.2, { color: 0x4c5762, bucket: 'metal' });
  L.box(48, 53, 0, 0.86, -33.0, -30.6, { color: 0x4c5762, bucket: 'metal' });
  L.box(44, 50, 0.86, 1.36, -39.4, -38.2, { color: 0x2b333c, bucket: 'metal' }); // 控制台
  L.box(41.2, 43.0, 1.0, 1.9, -34.8, -34.4, { color: 0x9fe6ff, bucket: 'metal', collide: false });
  L.box(48.4, 50.2, 1.0, 1.9, -35.2, -34.8, { color: 0x9fe6ff, bucket: 'metal', collide: false });
  L.box(44.4, 49.6, 1.36, 1.5, -39.2, -38.4, { color: 0x7fd0ff, bucket: 'metal', collide: false });
  // 行政侧
  L.box(24, 30, 0, 0.8, -38, -35.6, { color: 0x5a4a37, bucket: 'paint' });
  L.box(24, 30, 0, 0.8, -30, -27.6, { color: 0x5a4a37, bucket: 'paint' });
  L.box(31, 33, 0, 2.0, -41.2, -39.8, { color: 0x4b5560, bucket: 'metal' });
  L.sign('MERIDIAN PORT AUTHORITY', '港区调度 DISPATCH', 26.5, 4.0, -19.6, 10, 2.6, 0, { code: 'OP-D1' });
  L.sign('TALOS SICHERHEIT', '夜班值守', 55.6, 3.2, -30, 7, 2, Math.PI / 2, { code: 'SEC-07', accent: '#e8c247' });

  /* ---------------- 集装箱堆场 ---------------- */
  const CONT_COLORS = [0x3c5a52, 0x6b4a3a, 0x39506b, 0x5c5f66, 0x6d6238, 0x47394f];
  const container = (x, z, rot, levels, ci) => {
    const LEN = 12.2, WID = 2.44, HGT = 2.59;
    const color = CONT_COLORS[ci % CONT_COLORS.length];
    for (let l = 0; l < levels; l++) {
      const shade = ci % 3 === 0 ? color : color;
      L.rotBox(x, HGT * l + HGT / 2, z, LEN, HGT - 0.09, WID, rot, {
        color: shade, bucket: 'paint', tag: 'container',
      });
    }
    return { x, z, rot, levels };
  };
  const containers = [];
  // 西侧墙列（沿 Z）
  containers.push(container(-9.2, -46, Math.PI / 2, 2, 0));
  containers.push(container(-9.2, -32, Math.PI / 2, 2, 2));
  containers.push(container(-9.2, -18, Math.PI / 2, 1, 4));
  containers.push(container(-9.2, -5, Math.PI / 2, 2, 1));
  // 东侧墙列
  containers.push(container(9.2, -50, Math.PI / 2, 2, 3));
  containers.push(container(9.2, -36, Math.PI / 2, 2, 5));
  containers.push(container(9.2, -22, Math.PI / 2, 1, 2));
  containers.push(container(9.2, -9, Math.PI / 2, 2, 0));
  // 外侧堆
  containers.push(container(-15.4, -14, 0, 2, 4));
  containers.push(container(-15.4, -11, 0, 1, 5));
  containers.push(container(14.2, -44, 0, 1, 1));
  containers.push(container(14.2, -58, 0, 2, 3));
  containers.push(container(-15.0, -58, 0, 1, 2));
  containers.push(container(-27.0, -58, 0, 2, 5));
  // 场外散堆
  containers.push(container(20.0, 0.5, 0, 2, 0));
  containers.push(container(33.0, 0.5, 0, 1, 3));
  containers.push(container(-30.0, 12.0, Math.PI / 2, 2, 1));
  containers.push(container(-14.0, 16.0, 0, 2, 4));
  containers.push(container(0.0, 16.0, Math.PI / 2, 2, 2));
  containers.push(container(12.0, 22.0, 0, 1, 5));
  containers.push(container(-40.0, 22.0, Math.PI / 2, 1, 0));
  containers.push(container(34.0, 46.0, 0, 2, 3));
  containers.push(container(46.0, 44.0, Math.PI / 2, 2, 1));
  // 醒目编号贴片
  const codes = ['KRGU 214 388-7', 'KRGU 771 042-3', 'KRGU 508 619-1', 'KRGU 330 774-5', 'KRGU 662 190-8'];
  const decalMat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.24 });
  containers.slice(0, 9).forEach((c, i) => {
    const t = TX.containerCodeTexture('#' + new THREE.Color(CONT_COLORS[i % 6]).getHexString(), codes[i % codes.length]);
    const mm = decalMat.clone(); mm.map = t;
    for (let side = 0; side < 2; side++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(11.4, 2.1), mm);
      const off = 1.25 * (side ? 1 : -1);
      m.position.set(c.x + (c.rot ? off : 0), 1.35, c.z + (c.rot ? 0 : off));
      m.rotation.y = c.rot ? (side ? 0 : Math.PI) : (side ? Math.PI / 2 : -Math.PI / 2);
      scene.add(m);
    }
  });

  /* ---------------- 龙门吊 ---------------- */
  const craneZ0 = -62.5, craneZ1 = -50.5;
  for (const cz of [craneZ0, craneZ1]) {
    L.box(-30.0, -28.2, 0, 17, cz - 0.9, cz + 0.9, { color: 0x6c757e, bucket: 'metal' });
    L.box(28.2, 30.0, 0, 17, cz - 0.9, cz + 0.9, { color: 0x6c757e, bucket: 'metal' });
    // 行走轮
    for (const lx of [-29.1, 29.1]) {
      for (const dz of [-2.4, 2.4]) {
        L.cyl(lx, 0.55, cz + dz, 0.55, 0.6, { color: 0x2b3036, collide: false, lowPoly: true });
      }
    }
  }
  L.box(-31, 31, 16.4, 17.4, craneZ0 - 1.2, craneZ1 + 1.2, { color: 0x6c757e, bucket: 'metal' });
  L.box(-31, 31, 17.4, 18.0, -60.0, -53.0, { color: 0x59626b, bucket: 'metal', collide: false });
  // 吊具
  L.box(-2.2, 2.2, 12.4, 14.0, -58.6, -54.4, { color: 0xb0563a, bucket: 'metal', collide: false });
  L.box(-0.35, 0.35, 14.0, 16.4, -56.9, -56.2, { color: 0x39424a, bucket: 'metal', collide: false });
  L.box(-0.35, 0.35, 14.0, 16.4, -54.9, -54.2, { color: 0x39424a, bucket: 'metal', collide: false });
  L.sign('NORDBRÜCKE CRANE CO.', 'GANTRY 04 · 门机', -28.6, 12.0, -56.5, 9, 2.4, -Math.PI / 2, { code: 'CR-04', accent: '#ffd479' });

  /* ---------------- 货轮（远景剪影） ---------------- */
  const shipTex = TX.shipHullTexture();
  const shipMat = new THREE.MeshStandardMaterial({ map: shipTex, roughness: 0.75, metalness: 0.35, color: 0x8c9aa6 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(150, 13, 22), shipMat);
  hull.position.set(-6, 3.5, -104);
  scene.add(hull);
  const sup = new THREE.Mesh(new THREE.BoxGeometry(20, 15, 16), shipMat);
  sup.position.set(46, 16, -104);
  scene.add(sup);
  const fun = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x1d232a, roughness: 0.8, metalness: 0.3 }));
  fun.position.set(42, 26, -104);
  scene.add(fun);
  for (let i = 0; i < 5; i++) {
    const lx = -60 + i * 22;
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.6, 12, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: .8, metalness: .4 }));
    mast.position.set(lx, 15, -104);
    scene.add(mast);
  }
  const shipName = new THREE.Mesh(new THREE.PlaneGeometry(30, 3),
    new THREE.MeshStandardMaterial({
      map: TX.signTexture('SOLSTICE VIGIL', 'HANSA MERIDIAN SHIPPING', { bg: '#0b1218', glow: false }),
      emissive: 0x223038, emissiveIntensity: 0.4, roughness: .8,
    }));
  shipName.position.set(-6, 6, -92.8);
  scene.add(shipName);

  /* ---------------- 哨亭 / 道具 ---------------- */
  L.box(11, 17.4, 0, 3.2, 38, 43.6, { color: 0x39424c });
  L.box(11, 17.4, 0.0, 0.2, 38, 43.6, { color: 0x2c333c, collide: false, bucket: 'concrete' });
  L.box(10.6, 17.8, 3.2, 3.6, 37.6, 44.0, { color: 0x272d35, bucket: 'metal', collide: false });
  L.box(11.0, 17.4, 1.1, 2.6, 37.9, 38.0, { bucket: 'glass', collide: true, opaque: false, tag: 'glass' });
  L.sign('TALOS SICHERHEIT', 'GATE 1 · 南门', 10.7, 2.2, 40.8, 3.4, 1.1, -Math.PI / 2, { code: 'G1', glow: false });
  // 闸机与路障
  L.box(-7.4, -5.6, 0, 1.1, 49.4, 50.6, { color: 0x3a4249, bucket: 'concrete' });
  L.box(5.6, 7.4, 0, 1.1, 49.4, 50.6, { color: 0x3a4249, bucket: 'concrete' });
  for (const bx of [-9, -3, 3, 9]) {
    L.cyl(bx, 0.6, 47.4, 0.55, 1.2, { color: 0xb9bcc0, collide: true, lowPoly: true });
  }
  // 装甲车（撤离点）
  const apc = { x: 0, z: 54 };
  L.rotBox(apc.x, 1.35, apc.z, 7.4, 2.5, 2.9, 0, { color: 0x2f3a35, bucket: 'paint', tag: 'vehicle' });
  L.rotBox(apc.x, 3.0, apc.z + 0.1, 3.2, 1.1, 2.3, 0, { color: 0x333f39, bucket: 'paint', tag: 'vehicle' });
  L.rotBox(apc.x - 1.0, 3.75, apc.z, 1.4, 0.5, 1.4, 0, { color: 0x2a332e, bucket: 'paint', collide: false });
  for (const wx of [-2.6, 2.6]) for (const wz of [-1.55, 1.55]) {
    L.cyl(apc.x + wx, 0.6, apc.z + wz, 0.6, 0.42, { color: 0x12161a, collide: false, lowPoly: true });
  }
  L.sign('MPA', '战术警备', apc.x - 3.75, 1.8, apc.z, 2.6, 0.9, -Math.PI / 2, { glow: true, code: 'R-04' });

  // 叉车
  const fkX = 3.4, fkZ = -29;
  L.rotBox(fkX, 0.75, fkZ, 2.6, 1.5, 1.5, 0.35, { color: 0xc08a2e, bucket: 'paint', tag: 'prop' });
  L.rotBox(fkX + 0.2, 2.1, fkZ - 0.1, 1.5, 1.4, 1.2, 0.35, { color: 0x2a3038, bucket: 'metal', tag: 'prop', collide: false });
  L.rotBox(fkX + 1.6, 1.5, fkZ + 0.6, 0.35, 3.0, 1.6, 0.35, { color: 0x3d444c, bucket: 'metal', collide: false });
  for (const wx of [-0.7, 0.9]) for (const wz of [-0.8, 0.8]) {
    L.cyl(fkX + wx * 0.9, 0.42, fkZ + wz * 0.9, 0.42, 0.32, { color: 0x11151a, collide: false, lowPoly: true });
  }
  // 托盘 / 油桶 / 缆盘 / 轮胎
  for (let i = 0; i < 26; i++) {
    const x = rng.range(-66, 66), z = rng.range(-58, 46);
    const kind = rng.next();
    if (kind < 0.4) {
      L.box(x, x + 1.2, 0, 0.14, z, z + 1.1, { color: 0x6b573c, bucket: 'paint' });
      L.box(x + 0.05, x + 1.15, 0.14, 0.86, z + 0.1, z + 1.0, { color: 0x7a6446, bucket: 'paint' });
    } else if (kind < 0.72) {
      L.cyl(x, 0.44, z, 0.32, 0.88, { color: 0x2f5a6b, collide: true, lowPoly: true });
      L.cyl(x + 0.75, 0.44, z + 0.2, 0.32, 0.88, { color: 0x8a5a2a, collide: true, lowPoly: true });
    } else if (kind < 0.87) {
      L.cyl(x, 0.6, z, 0.9, 1.2, { color: 0x2b3138, collide: true, lowPoly: true });
    } else {
      L.cyl(x, 0.36, z, 0.62, 0.24, { color: 0x15181c, collide: true, lowPoly: true });
      L.cyl(x + 0.1, 0.72, z + 0.3, 0.62, 0.24, { color: 0x181b1f, collide: true, lowPoly: true });
    }
  }

  /* ---------------- 路灯 ---------------- */
  const lampSpots = [
    [-17.5, -52, 0], [16, -52, 0], [-17.5, -26, 0], [16, -26, 0],
    [-17.5, 2, 0], [16, 2, 0], [0, 22, 0], [-34, 12, 0],
    [46, -46, 0], [-30, 46, 0], [22, 44, 0],
  ];
  const glowTex = glowTexture();
  const lampGlowMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xffc07a, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.55,
  });
  lampSpots.forEach((s, i) => {
    const [x, z] = s;
    L.cyl(x, 4.6, z, 0.16, 9.2, { color: 0x4b535b, collide: true, lowPoly: true });
    L.box(x - 0.5, x + 0.5, 9.2, 9.45, z - 0.5, z + 0.5, { color: 0x2c3238, bucket: 'metal', collide: false });
    L.box(x - 0.45, x + 0.45, 8.95, 9.2, z - 0.45, z + 0.45,
      { color: 0xffd39a, bucket: 'lamp', collide: false });
    const sp = new THREE.Sprite(lampGlowMat.clone());
    sp.position.set(x, 9.0, z);
    sp.scale.set(7, 7, 1);
    scene.add(sp);
  });

  /* ---------------- 水洼 ---------------- */
  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0x070d13, roughness: 0.03, metalness: 1.0, transparent: true, opacity: 0.9,
    envMapIntensity: 2.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  for (let i = 0; i < 46; i++) {
    const x = rng.range(-68, 68), z = rng.range(-62, 48);
    const r = rng.range(0.7, 3.6);
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 14), puddleMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = rng.range(0, 6.28);
    m.position.set(x, 0.012 + i * 0.00005, z);
    m.scale.set(1, rng.range(0.5, 1.0), 1);
    scene.add(m);
  }

  /* ---------------- 贴花：地面标线 ---------------- */
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xc9d3d8, transparent: true, opacity: 0.16 });
  for (let i = -3; i <= 3; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 108), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(i * 5.6, 0.02, -8);
    scene.add(m);
  }

  /* ---------------- 灯光 ---------------- */
  const hemi = new THREE.HemisphereLight(0x35506a, 0x0a0e13, 0.58);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x9dc3e6, 0.54);
  moon.position.set(38, 62, -26);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.near = 1;
  moon.shadow.camera.far = 170;
  moon.shadow.camera.left = -52;
  moon.shadow.camera.right = 52;
  moon.shadow.camera.top = 52;
  moon.shadow.camera.bottom = -52;
  moon.shadow.bias = -0.0009;
  moon.shadow.normalBias = 0.03;
  scene.add(moon);
  scene.add(moon.target);

  const lampLights = [];
  [0, 2, 3, 5, 6, 8].forEach((idx) => {
    const [x, z] = lampSpots[idx];
    const pl = new THREE.PointLight(0xffb877, 74, 36, 1.9);
    pl.position.set(x, 8.7, z);
    scene.add(pl);
    lampLights.push(pl);
  });
  // 建筑内部补光
  const fillA = new THREE.PointLight(0xcfe6ff, 42, 34, 1.9); fillA.position.set(-46, 6.5, -10); scene.add(fillA);
  const fillD = new THREE.PointLight(0xa8dcff, 46, 34, 1.9); fillD.position.set(44, 5.0, -32); scene.add(fillD);
  const fillB = new THREE.PointLight(0xbfe2ff, 36, 32, 1.9); fillB.position.set(36, 6.0, 22); scene.add(fillB);
  const fillOff = new THREE.PointLight(0xffe0b0, 16, 16, 2.0); fillOff.position.set(-28, 2.7, -21.4); scene.add(fillOff);
  const lightning = new THREE.AmbientLight(0xbcd8f0, 0.0);
  scene.add(lightning);

  /* ---------------- 构建批次 ---------------- */
  const batchMeshes = L.batch.build(mats, scene, true, true);

  /* ---------------- 掩体点 ---------------- */
  const covers = [];
  const coverIdx = new Grid(6);
  for (const b of grid.boxes) {
    const h = b.max.y - b.min.y;
    if (h < 1.0 || b.tag === 'fence') continue;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const ex = (b.max.x - b.min.x) / 2, ez = (b.max.z - b.min.z) / 2;
    const pad = 1.05;
    const cands = [
      [b.min.x - pad, cz, Math.PI / 2], [b.max.x + pad, cz, -Math.PI / 2],
      [cx, b.min.z - pad, 0], [cx, b.max.z + pad, Math.PI],
    ];
    if (ex > 9 || ez > 9) {
      for (let t = 0.25; t <= 0.75; t += 0.25) {
        cands.push([b.min.x - pad, b.min.z + ez * 2 * t, Math.PI / 2]);
        cands.push([b.max.x + pad, b.min.z + ez * 2 * t, -Math.PI / 2]);
        cands.push([b.min.x + ex * 2 * t, b.min.z - pad, 0]);
        cands.push([b.min.x + ex * 2 * t, b.max.z + pad, Math.PI]);
      }
    }
    for (const [x, z, face] of cands) {
      if (x < -74 || x > 74 || z < -64 || z > 48) continue;
      const hits = grid.queryCircle(x, z, 0.55, []);
      let blocked = false;
      for (const o of hits) {
        if (o === b) continue;
        if (o.max.y <= 0.4) continue;
        if (o.min.y > 2.0) continue;
        if (x + 0.55 > o.min.x && x - 0.55 < o.max.x && z + 0.55 > o.min.z && z - 0.55 < o.max.z) { blocked = true; break; }
      }
      if (blocked) continue;
      const c = { x, z, face, box: b };
      coverIdx.add({ min: { x: x - 0.5, y: 0, z: z - 0.5 }, max: { x: x + 0.5, y: 2, z: z + 0.5 }, tag: 'cover', ref: c });
      covers.push(c);
    }
  }

  /* ---------------- 任务点 / 区域 ---------------- */
  const objectives = {
    manifest: { x: -29.4, z: -23.4, label: '货运货单', zone: 'BAY 3 办公室' },
    evidence: { x: 47.0, z: -36.6, label: '调度室证据', zone: '港区调度楼' },
    extract: { x: 0, z: 53, label: '撤离点', zone: '南门装甲车' },
  };
  const safeZone = { x0: -10, x1: 10, z0: 42, z1: 50, label: '南门集结区' };

  /* short 供小地图使用（空间小，只放中文短名）；label 供战术地图使用 */
  const zones = [
    { x0: -72, x1: 72, z0: 42, z1: 50, label: '南门 / GATE 1', short: '南门', kind: 'gate' },
    { x0: -18, x1: 18, z0: -60, z1: 8, label: '集装箱堆场 / YARD', short: '堆场', kind: 'yard' },
    { x0: -64, x1: -20, z0: -26, z1: 4, label: '三号仓 / BAY 3', short: '三号仓', kind: 'building' },
    { x0: -34, x1: -21.2, z0: -25.4, z1: -17.4, label: 'BAY 3 办公室', short: '办公室', kind: 'room' },
    { x0: 18, x1: 62, z0: 6, z1: 40, label: '冷库 / KÜHLHAUS', short: '冷库', kind: 'building' },
    { x0: 22, x1: 54, z0: -42, z1: -20, label: '调度楼 / DISPATCH', short: '调度楼', kind: 'building' },
    { x0: 39, x1: 54, z0: -42, z1: -20, label: '调度室', short: '调度室', kind: 'room' },
    { x0: -72, x1: 72, z0: -66, z1: -50, label: '三号泊位 / BERTH 3', short: '三号泊位', kind: 'quay' },
  ];

  /* ---------------- 出生点 ---------------- */
  const spawns = {
    player: { x: 0, z: 43.5, yaw: 0 },
    squad: [
      { x: -2.6, z: 46.4, yaw: 0.12 },
      { x: 2.6, z: 46.4, yaw: -0.12 },
      { x: -4.6, z: 48.6, yaw: 0.2 },
      { x: 4.6, z: 48.6, yaw: -0.2 },
    ],
  };

  /* ---------------- 嫌疑人 ---------------- */
  const suspects = [
    { id: 'S1', name: '白鹭-1', patrol: [[-4, -50], [5, -44], [-6, -38]], speed: 1.25 },
    { id: 'S2', name: '白鹭-2', patrol: [[6, -30], [-2, -23], [6, -14]], speed: 1.15 },
    { id: 'S3', name: '白鹭-3', patrol: [[-32, -10], [-52, -8], [-48, 0], [-26, -5]], speed: 1.1 },
    { id: 'S4', name: '白鹭-4', post: [-24.6, -20.6], speed: 1.0, elite: true },
    { id: 'S5', name: '白鹭-5', post: [41.6, -25.6], speed: 1.0 },
    { id: 'S6', name: '白鹭-6', patrol: [[49, -38], [26, -38], [27, -24]], speed: 1.2 },
    { id: 'S7', name: '白鹭-7', patrol: [[-14, -57], [10, -57], [16, -47]], speed: 1.25 },
    { id: 'S8', name: '白鹭-8', patrol: [[24, 12], [52, 14], [50, 34], [26, 32]], speed: 1.1 },
    { id: 'S9', name: '白鹭-9', post: [19, 34], speed: 1.0, rear: true },
  ];

  /* ---------------- 平民 ---------------- */
  const civilians = [
    { id: 'C1', x: 1.5, z: -27.0, label: '夜班装卸工' },
    { id: 'C2', x: -46.0, z: -12.0, label: '仓库理货员' },
    { id: 'C3', x: 34.0, z: 25.0, label: '冷库值班员' },
    { id: 'C4', x: -10.5, z: 15.0, label: '夜间巡场工' },
  ];

  /* ---------------- 更新 ---------------- */
  const rain = buildRain(scene);
  let t = 0;
  let nextLightning = 18 + rng.range(0, 26);
  let lightningT = -1;
  const thunderCb = [];

  function update(dt, camPos) {
    t += dt;
    rain.mat.uniforms.uTime.value = t;
    rain.mesh.position.set(Math.round(camPos.x), 0, Math.round(camPos.z));
    // 阴影相机跟随
    moon.position.set(camPos.x + 38, 62, camPos.z - 26);
    moon.target.position.set(camPos.x, 0, camPos.z);
    moon.target.updateMatrixWorld();
    // 闪电
    if (lightningT < 0 && t > nextLightning) {
      lightningT = 0;
      nextLightning = t + 26 + rng.range(0, 34);
      thunderCb.forEach((cb) => cb());
    }
    if (lightningT >= 0) {
      lightningT += dt;
      const p = lightningT;
      let v = 0;
      if (p < 0.09) v = 1 - p / 0.09;
      else if (p < 0.16) v = 0.15;
      else if (p < 0.30) v = 0.75 * (1 - (p - 0.16) / 0.14);
      lightning.intensity = v * 1.5;
      if (p > 0.34) { lightningT = -1; lightning.intensity = 0; }
    }
  }

  return {
    grid, level: L, batchMeshes, mats, covers, coverIdx,
    objectives, zones, safeZone, spawns, suspects, civilians, containers,
    lights: { hemi, moon, lampLights, lightning, fills: [fillA, fillB, fillD] },
    rain, update,
    onThunder: (cb) => thunderCb.push(cb),
    bounds: WORLD.bounds,
  };
}
