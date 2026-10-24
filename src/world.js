/* reused query buffer for one-off build-time work (avoids new arrays inside the candidate loop) */
const _coverScratch = [];

/* ============================================================
   world.js — original port layout / lighting / sea-fog night atmosphere
   Coordinates: X east, -Z north (towards the quay), +Y up, metres
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
   Geometry batcher: merges many static boxes into a few meshes
   ============================================================ */
const _nonIndexedCache = new WeakMap();
function nonIndexed(g) {
  if (!g.index) return g;
  let c = _nonIndexedCache.get(g);
  if (!c) { c = g.toNonIndexed(); _nonIndexedCache.set(g, c); }
  return c;
}

/* ============================================================
   Layered fog
   ------------------------------------------------------------
   Density stays FogExp2 0.0158 (gameplay: visibility ~46 m). Only the colour changes with distance:
     · close to the camera the fog is the colder, darker air between you and the next lamp — clean
     · beyond ~40–55 m it converges to the sky's horizon radiance: lamp light scattered in the fog layer,
       warm and luminous, so distant geometry dissolves into the sky instead of meeting it at a line
   fogColor (the uniform) is the far colour; FOG_NEAR_TINT scales it down and cools it near the camera.
   Patched once, globally, before any material compiles (three resolves #include chunks at compile time).
   ============================================================ */
THREE.ShaderChunk.fog_fragment = [
  '#ifdef USE_FOG',
  '  #ifdef FOG_EXP2',
  '    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
  '  #else',
  '    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
  '  #endif',
  '  vec3 fogTint = mix( vec3( 0.42, 0.50, 0.66 ), vec3( 1.0 ), smoothstep( 12.0, 55.0, vFogDepth ) );',
  '  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * fogTint, fogFactor );',
  '#endif',
].join('\n');

/* time-varying atmosphere (shaft noise, mote drift) freezes under prefers-reduced-motion */
let REDUCED_MOTION = false;
try {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  REDUCED_MOTION = mq.matches;
  if (mq.addEventListener) mq.addEventListener('change', (e) => { REDUCED_MOTION = e.matches; });
} catch (e) { /* no matchMedia: motion stays on */ }

/* ============================================================
   Light levels (all relative to renderer.toneMappingExposure = 1.0 in game.js)
   ============================================================ */
const SODIUM = 0xffa155;            // high-pressure sodium, ~2000 K
const ENV_INTENSITY = 2.6;          // sky dome as indirect light
const SKY_BG_INTENSITY = 1.0;       // sky dome as seen by the camera
const FOG_HORIZON_MATCH = 1.0;      // fog colour = horizon radiance × this
const HEMI_INTENSITY = 0.35;
const BOUNCE_INTENSITY = 0.06;      // per light, three of them
const MOON_INTENSITY = 0.28;
const LAMP_INTENSITY = 900;         // candela-scale; pool centre irradiance ≈ I / h² ≈ 11
const FAR_FILL_INTENSITY = 7;
const SHAFT_INTENSITY = 0.22;      // additive radiance at the brightest part of a beam
const MOTE_INTENSITY = 2.5;
const GROUND_SIZE = 400;
/* interiors see almost no open sky: the roof and walls occlude ~80% of the hemisphere */
const SKY_INTERIOR = 0.22;
const INTERIORS = [
  { x0: -64, x1: -20, z0: -26, z1: 4 },      // Bay 3
  { x0: 18, x1: 62, z0: 6, z1: 40 },         // cold store
  { x0: 22, x1: 54, z0: -42, z1: -20 },      // dispatch
];

/* Albedo correction per batch bucket.
   The vertex colours were authored against the old rig, where the concrete texture itself was ~0.017 linear
   and every lit surface was multiplied down to near black (effective wall albedo ~0.0006, asphalt ~0.007).
   Real values: weathered concrete 0.2–0.3, painted steel 0.1–0.3, container paint 0.08–0.2.
   The concrete map is now a near-white detail map (mean ~0.7) and the vertex colour carries the albedo,
   lifted here in linear space by one documented factor per bucket instead of editing ~80 literals.
   This is a material property, not exposure: lights and exposure are unchanged by it. */
const ALBEDO_LIFT = { concrete: 3.2, metal: 1.8, paint: 1.5, container: 1.5, containerEnd: 1.5 };
const ALBEDO_MAX = 0.6;

class Batcher {
  constructor() {
    this.b = new Map();
    /* reused temporaries for add() */
    this._nm = new THREE.Matrix3();
    this._v = new THREE.Vector3();
    this._vn = new THREE.Vector3();
    this._c = new THREE.Color();
  }
  _b(name) {
    let o = this.b.get(name);
    if (!o) this.b.set(name, (o = { pos: [], nor: [], col: [], uv: [], sky: [] }));
    return o;
  }
  /* sky: baked sky visibility 0..1 for this piece (1 = open sky, ~0.2 = inside a building).
     It scales only indirect light (hemisphere + environment), see patchSkyVisibility().
     opts.uv:    'unit'  (default) the geometry's own 0..1 per-face UVs
                 'world' UVs in world metres, box-projected by face normal (continuous across adjacent pieces)
                 'local' UVs in metres of the box's own dimensions (opts.dims = [sx, sy, sz]); v = height from the box bottom
     opts.ends:  bucket for faces whose local normal is ±X (container door ends); other faces go to `name` */
  add(name, geo, matrix, color, sky = 1, opts) {
    const src = nonIndexed(geo);
    const p = src.attributes.position.array;
    const n = src.attributes.normal.array;
    const u = src.attributes.uv ? src.attributes.uv.array : null;
    const uvMode = (opts && opts.uv) || 'unit';
    const dims = opts && opts.dims;
    const main = this._b(name);
    const ends = opts && opts.ends ? this._b(opts.ends) : null;
    /* reused temporaries: add() used to allocate Matrix3 + 2×Vector3 + Color on every call */
    const nm = this._nm.getNormalMatrix(matrix);
    const v = this._v, vn = this._vn, c = this._c.set(color);
    const lift = ALBEDO_LIFT[name] || 1;
    if (lift !== 1) {
      c.r = Math.min(ALBEDO_MAX, c.r * lift); c.g = Math.min(ALBEDO_MAX, c.g * lift); c.b = Math.min(ALBEDO_MAX, c.b * lift);
    }
    for (let i = 0, k = 0; i < p.length; i += 3, k += 2) {
      const lx = p[i], ly = p[i + 1], lz = p[i + 2];
      const ax = Math.abs(n[i]), ay = Math.abs(n[i + 1]), az = Math.abs(n[i + 2]);
      const o = ends && ax > ay && ax > az ? ends : main;
      v.set(lx, ly, lz).applyMatrix4(matrix);
      vn.set(n[i], n[i + 1], n[i + 2]).applyMatrix3(nm).normalize();
      o.pos.push(v.x, v.y, v.z);
      o.nor.push(vn.x, vn.y, vn.z);
      o.col.push(c.r, c.g, c.b);
      o.sky.push(sky);
      if (uvMode === 'world') {
        const wx = Math.abs(vn.x), wy = Math.abs(vn.y), wz = Math.abs(vn.z);
        if (wx >= wy && wx >= wz) o.uv.push(v.z, v.y);
        else if (wy >= wz) o.uv.push(v.x, v.z);
        else o.uv.push(v.x, v.y);
      } else if (uvMode === 'local' && dims) {
        if (ax >= ay && ax >= az) o.uv.push((lz + 0.5) * dims[2], (ly + 0.5) * dims[1]);
        else if (ay >= az) o.uv.push((lx + 0.5) * dims[0], (lz + 0.5) * dims[2]);
        else o.uv.push((lx + 0.5) * dims[0], (ly + 0.5) * dims[1]);
      } else if (u) {
        o.uv.push(u[k], u[k + 1]);
      } else {
        o.uv.push(0, 0);
      }
    }
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
      g.setAttribute('skyVis', new THREE.Float32BufferAttribute(o.sky, 1));
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

/* Baked sky visibility: scales indirect light (hemisphere + environment) by the per-vertex skyVis attribute,
   leaving direct lights untouched. Without it a warehouse interior receives the full open-sky ambient
   through its roof. Inserted right after three's lights_fragment_maps chunk, where `irradiance`,
   `iblIrradiance` and `radiance` hold exactly the indirect terms. */
function patchSkyVisibility(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float skyVis;\nvarying float vSkyVis;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkyVis = skyVis;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSkyVis;')
      .replace('#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\nirradiance *= vSkyVis;\n#if defined( RE_IndirectSpecular )\niblIrradiance *= vSkyVis;\nradiance *= vSkyVis;\n#endif');
  };
}

/* Wet ground: water darkens the base layer (light that enters the film is absorbed by the wet asphalt instead of
   scattering back out), and grime (tyre tracks, oil) darkens it further. Both read from the wetness mask that
   already drives clearcoat (.r) and roughness (.g); .b is grime. */
function patchWetGround(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', [
      '#include <map_fragment>',
      '#ifdef USE_CLEARCOATMAP',
      '  vec3 wetMask = texture2D( clearcoatMap, vClearcoatMapUv ).rgb;',
      '  diffuseColor.rgb *= mix( 1.0, 0.45, wetMask.r ) * mix( 1.0, 0.55, wetMask.b );',
      '#endif',
    ].join('\n'));
  };
}

/* merge indexed plane geometries (position/normal/uv) into one */
function mergePlanes(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, ov * 3); nor.set(g.attributes.normal.array, ov * 3); uv.set(g.attributes.uv.array, ov * 2);
    const ia = g.index.array; for (let i = 0; i < ia.length; i++) idx[oi + i] = ia[i] + ov;
    ov += g.attributes.position.count; oi += ia.length;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  return m;
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UV_WORLD = { uv: 'world' };
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
const UNIT_CYL_LO = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);

/* ============================================================
   Level: produces geometry and colliders together
   ============================================================ */
class Level {
  constructor(scene, grid) {
    this.scene = scene;
    this.grid = grid;
    this.batch = new Batcher();
    this.rng = makeRng(20260924);
    this.signs = [];
    this.covers = [];
    this.sky = 1;                 // sky visibility stamped on everything added until changed (interiors set it low)
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  /** Add a box by its bounds + collider */
  box(x0, x1, y0, y1, z0, z1, o = {}) {
    const bucket = o.bucket || 'concrete';
    const color = o.color !== undefined ? o.color : 0x39404a;
    if (o.visible !== false) {
      this._v.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      this._s.set(Math.abs(x1 - x0) || 0.02, Math.abs(y1 - y0) || 0.02, Math.abs(z1 - z0) || 0.02);
      this._m.compose(this._v, new THREE.Quaternion(), this._s);
      this.batch.add(bucket, UNIT_BOX, this._m, color, this.sky, bucket === 'concrete' ? UV_WORLD : undefined);
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

  /** Rotated box (containers, props) */
  rotBox(cx, cy, cz, sx, sy, sz, ry, o = {}) {
    const bucket = o.bucket || 'paint';
    const color = o.color !== undefined ? o.color : 0x445a52;
    this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    this._v.set(cx, cy, cz);
    this._s.set(sx, sy, sz);
    this._m.compose(this._v, this._q, this._s);
    this.batch.add(bucket, UNIT_BOX, this._m, color, this.sky,
      bucket === 'container' ? { uv: 'local', dims: [sx, sy, sz], ends: 'containerEnd' } : undefined);
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
    this.batch.add(bucket, o.lowPoly ? UNIT_CYL_LO : UNIT_CYL, this._m, color, this.sky);
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
   * Wall running along Z (at constant x), with optional door/window openings.
   * openings: [{from,to,sill,head,glass}] — from/to are z coordinates
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

  /** Wall running along X (at constant z) */
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
   Sky dome: one vertical gradient shared by the environment map (lighting) and the background (what you see)
   ------------------------------------------------------------
   Physical picture: a low sea-fog layer lit from below by the port's sodium lamps.
     · the fog scatters that light most strongly near the horizon → a dirty orange band, the brightest part of the sky
     · towards the zenith you look through less lit fog → it falls off to a cold, dim blue-grey (never black)
     · below the horizon (seen by surfaces, not the camera) is wet ground reflecting lamp pools → warm and dark
   Equirectangular: t = 0 zenith, 0.5 horizon, 1 nadir. Values are sRGB, decoded to linear by the texture colour space.
   ============================================================ */
export const SKY_STOPS = [
  [0.00, '#0e1621'],
  [0.22, '#141d29'],
  [0.36, '#20252f'],
  [0.44, '#352f2e'],
  [0.485, '#4f3f33'],
  [0.50, '#584536'],
  [0.515, '#47382d'],
  [0.56, '#2a231d'],
  [1.00, '#14120f'],
];
/* the sky colour right at the horizon; fog must converge to this so distant geometry dissolves into the sky */
export const SKY_HORIZON = '#584536';

function paintSkyGradient(g, w, h) {
  const grd = g.createLinearGradient(0, 0, 0, h);
  for (const [t, c] of SKY_STOPS) grd.addColorStop(t, c);
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
}

/* ============================================================
   Environment map (indirect light + wet reflections)
   ============================================================ */
function buildEnvironment(renderer) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  paintSkyGradient(g, 512, 256);
  /* lamp heads and lit windows around the horizon: these give wet surfaces their warm specular glints */
  for (let i = 0; i < 26; i++) {
    const x = TX.rand() * 512, y = 120 + TX.rand() * 10;
    const r = 4 + TX.rand() * 10;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(255,190,120,.9)');
    rg.addColorStop(1, 'rgba(255,170,100,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 6.3); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  /* Return the render target itself, not just rt.texture:
     once the RT is dropped its framebuffer / texture can never be freed,
     so every redeploy leaked textures and framebuffers. */
  return rt;
}

/* Night sky as a shader on a camera-following sphere. Analytic, per pixel, no texture: any magnified sky texture
   (the original 1024×512 equirect, or a 2048 canvas) showed its texel grid on smooth gradients — visible in every
   screenshot since the start. The gradient uses the same SKY_STOPS as the environment map, mixed in sRGB like the
   canvas gradient and then decoded, so lighting, sky and fog agree. Cloud banks are procedural value noise,
   lighter and warmer lower down where they catch the port's light. */
function buildSkyMaterial() {
  const stops = SKY_STOPS.map(([t]) => t);
  const cols = SKY_STOPS.map(([, c]) => { const k = new THREE.Color(c); return new THREE.Vector3(k.r, k.g, k.b); });
  // THREE.Color(hex) converts sRGB → linear; go back to sRGB values so the mix happens where the canvas mixes
  const toS = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  cols.forEach((v) => v.set(toS(v.x), toS(v.y), toS(v.z)));
  const N = stops.length;
  return new THREE.ShaderMaterial({
    uniforms: { stops: { value: stops }, cols: { value: cols }, intensity: { value: SKY_BG_INTENSITY } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize( ( modelMatrix * vec4( position, 1.0 ) ).xyz - cameraPosition );
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: `
      uniform float stops[ ${N} ]; uniform vec3 cols[ ${N} ]; uniform float intensity;
      varying vec3 vDir;
      float h21( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
      float vnoise( vec2 p ) {
        vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), f.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
      }
      float fbm( vec2 p ) { float a = 0.5, v = 0.0; for ( int i = 0; i < 4; i++ ) { v += a * vnoise( p ); p *= 2.03; a *= 0.5; } return v; }
      vec3 srgbToLinear( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }
      void main() {
        vec3 d = normalize( vDir );
        float t = acos( clamp( d.y, -1.0, 1.0 ) ) / 3.14159265;     // 0 zenith, 0.5 horizon, 1 nadir
        vec3 c = cols[ 0 ];
        for ( int i = 1; i < ${N}; i++ ) {
          float k = clamp( ( t - stops[ i - 1 ] ) / max( stops[ i ] - stops[ i - 1 ], 1e-4 ), 0.0, 1.0 );
          c = t >= stops[ i - 1 ] ? mix( cols[ i - 1 ], cols[ i ], k ) : c;
        }
        /* fog banks between ~5° and ~50° above the horizon */
        float elev = d.y;
        float band = smoothstep( 0.03, 0.12, elev ) * ( 1.0 - smoothstep( 0.35, 0.8, elev ) );
        vec2 q = vec2( atan( d.z, d.x ) * 2.2, elev * 9.0 );
        float n = fbm( q * vec2( 1.0, 2.6 ) + vec2( 3.1, 0.0 ) );
        float cloud = smoothstep( 0.48, 0.78, n ) * band;
        vec3 warm = mix( vec3( 0.20, 0.20, 0.23 ), vec3( 0.36, 0.30, 0.26 ), 1.0 - smoothstep( 0.05, 0.5, elev ) );
        c = mix( c, max( c, warm ), cloud * 0.45 );
        gl_FragColor = vec4( srgbToLinear( c ) * intensity, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
}

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
   Build the world
   ============================================================ */
export function buildWorld(scene, renderer) {
  TX.reseedTextures();
  const grid = new Grid(8);
  const L = new Level(scene, grid);
  const rng = L.rng;

  /* Fog density is gameplay (briefing: visibility ~46 m) and stays as it was. Its colour now converges to the
     horizon of the sky dome, so geometry fades into the sky instead of into a darker blue than the sky. */
  scene.fog = new THREE.FogExp2(new THREE.Color(SKY_HORIZON).multiplyScalar(SKY_BG_INTENSITY * FOG_HORIZON_MATCH), 0.0158);
  /* Background and environment textures aren't in the scene graph, so scene.traverse misses them;
     hold explicit references and free them in disposeMission. */
  const skyTex = null;
  /* sky sphere following the camera, drawn first, never fogged (its horizon IS the fog's far colour) */
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(380, 48, 24), buildSkyMaterial());
  skyDome.renderOrder = -1000;
  skyDome.frustumCulled = false;
  scene.add(skyDome);
  scene.background = null;
  const envRT = buildEnvironment(renderer);
  scene.environment = envRT.texture;
  /* Note: for a MeshStandardMaterial without its own envMap, three r180 takes envMapIntensity from
     scene.environmentIntensity (WebGLRenderer.setProgram). Per-material envMapIntensity values on such
     materials were never applied, so this global is the one real knob for image-based light. */
  scene.environmentIntensity = ENV_INTENSITY;

  /* ---------------- Materials ---------------- */
  const asphalt = TX.asphaltSet();
  /* ground plane is 400 m with 0..1 UVs: 100 repeats = one 4 m tile */
  asphalt.map.repeat.setScalar(GROUND_SIZE / TX.ASPHALT_TILE_M);
  asphalt.normalMap.repeat.copy(asphalt.map.repeat);
  const side = TX.containerSideSet(), end = TX.containerEndSet();
  /* Physics pass: asphalt, water and paint are dielectrics (metalness 0, F0 ≈ 0.04 / 0.02).
     Their specular now comes from Fresnel on a smooth-ish surface reflecting the sky dome and the lamps —
     weak head-on, strong at grazing angles, which is exactly how wet ground behaves — instead of from
     pretending to be metal, which tinted reflections by albedo and gave the plastic look.
     "metal" is mostly painted steel (racking, roofs, crane): paint over steel is a dielectric too;
     a small metalness keeps a hint of the bare edges and galvanising. */
  const mats = {
    /* Wet asphalt: a dielectric base (grain normal map, roughness from the wetness mask) under a clearcoat
       water film whose strength is the same mask. Where the mask is dry the coat vanishes and the asphalt is
       rough; in standing water the coat is a flat mirror over the grain. The mask itself is assigned once
       the puddle positions are known (see "Wetness" below). */
    asphalt: new THREE.MeshPhysicalMaterial({
      map: asphalt.map, normalMap: asphalt.normalMap, normalScale: new THREE.Vector2(0.55, 0.55),
      color: 0xffffff, roughness: 1, metalness: 0,
      /* coat roughness = 0.5 × mask.g: ~0.02 in standing water (a mirror), ~0.25 on damp ground, where the lamp
         reflections become soft streaks that stretch towards the viewer at grazing angles */
      clearcoat: 1, clearcoatRoughness: 0.5,
    }),
    /* harbour water: ior 1.33 (F0 ≈ 0.02), smooth, a static ripple normal so lamp reflections break up */
    water: new THREE.MeshPhysicalMaterial({
      color: 0x080c0f, roughness: 0.07, metalness: 0, ior: 1.33,
      normalMap: TX.rippleNormal(), normalScale: new THREE.Vector2(0.35, 0.35),
    }),
    concrete: new THREE.MeshStandardMaterial({
      map: TX.concreteTexture(), vertexColors: true, roughness: 0.85, metalness: 0,
    }),
    metal: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.55, metalness: 0.2,
    }),
    paint: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.6, metalness: 0,
    }),
    /* containers: painted corrugated steel, long sides and door ends with their own detail and normal maps */
    container: new THREE.MeshStandardMaterial({
      vertexColors: true, map: side.map, normalMap: side.normalMap, roughness: 0.58, metalness: 0,
    }),
    containerEnd: new THREE.MeshStandardMaterial({
      vertexColors: true, map: end.map, normalMap: end.normalMap, roughness: 0.6, metalness: 0,
    }),
    /* glass: a real dielectric (ior 1.5) — almost invisible head-on, a mirror at grazing angles.
       No transmission pass (it would re-render the opaque scene and double the draw calls). */
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x8fb4bd, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, ior: 1.5,
      side: THREE.DoubleSide, depthWrite: false,
    }),
    lamp: new THREE.MeshStandardMaterial({
      /* the lamp head is the light source: it must out-shine everything it lights */
      color: 0xffe3b8, emissive: 0xffb46b, emissiveIntensity: 6,
      roughness: 0.35, metalness: 0.1,
    }),
  };
  mats.concrete.map.wrapS = mats.concrete.map.wrapT = THREE.RepeatWrapping;
  for (const k of ['concrete', 'metal', 'paint', 'container', 'containerEnd']) patchSkyVisibility(mats[k]);
  patchWetGround(mats.asphalt);

  /* ---------------- Ground / water ---------------- */
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), mats.asphalt);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.position.y = 0;
  scene.add(ground);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(520, 260), mats.water);
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -1.5, WORLD.waterZ - 130);
  scene.add(water);

  /* ---------------- Quay edge ---------------- */
  L.box(-80, 80, -1.6, 0.02, WORLD.waterZ - 2.2, WORLD.waterZ, { color: 0x2b3138, bucket: 'concrete' });
  L.box(-80, 80, 0.0, 0.5, WORLD.waterZ - 0.2, WORLD.waterZ + 0.9, { color: 0x3a424c, bucket: 'concrete' });
  for (let x = -76; x <= 76; x += 9) {
    L.cyl(x, 0.62, WORLD.waterZ + 0.4, 0.42, 0.62, { color: 0x2f353c, collide: false, lowPoly: true });
    L.cyl(x, 1.05, WORLD.waterZ + 0.4, 0.19, 0.5, { color: 0x50585f, collide: false, lowPoly: true });
  }
  // fenders
  for (let x = -70; x <= 70; x += 16) {
    L.cyl(x, -0.4, WORLD.waterZ - 0.35, 0.5, 1.5, { color: 0x15181c, collide: false, lowPoly: true });
  }

  /* ---------------- Fence ---------------- */
  const fenceMat = new THREE.MeshStandardMaterial({
    /* alphaTest alone cuts the mesh holes; transparent:true is not needed.
       Marking it transparent would put it in the transparent queue: sorted every frame,
       no depth prepass, and unreliable draw order against what it occludes. */
    map: TX.fenceTexture(), transparent: false, alphaTest: 0.28, side: THREE.DoubleSide,
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
    // posts
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

  /* ---------------- Bay 3 ---------------- */
  const whA = { x0: -64, x1: -20, z0: -26, z1: 4, h: 9.5 };
  const wallC = 0x333a45;
  // floor
  L.sky = SKY_INTERIOR;
  L.box(whA.x0, whA.x1, 0.0, 0.14, whA.z0, whA.z1, { color: 0x2c333c, bucket: 'concrete', collide: false });
  L.sky = 1;
  // four walls: west solid, east with two cargo doors, south with an entrance
  L.wallX(whA.x0 + 0.3, 0.6, whA.z0, whA.z1, 0, whA.h, [], wallC);
  L.wallX(whA.x1 - 0.3, 0.6, whA.z0, whA.z1, 0, whA.h, [
    { from: -22.4, to: -16.0, sill: 0, head: 6.4, glass: false },
    { from: -8.4, to: -2.0, sill: 0, head: 6.4, glass: false },
  ], wallC);
  L.wallZ(whA.z0 + 0.3, 0.6, whA.x0, whA.x1, 0, whA.h, [], wallC);
  L.wallZ(whA.z1 - 0.3, 0.6, whA.x0, whA.x1, 0, whA.h, [
    { from: -40.4, to: -36.6, sill: 0, head: 3.0, glass: false },
  ], wallC);
  // roof
  L.box(whA.x0 - 0.4, whA.x1 + 0.4, whA.h, whA.h + 0.5, whA.z0 - 0.4, whA.z1 + 0.4,
    { color: 0x252b33, bucket: 'metal' });

  // interior columns
  L.sky = SKY_INTERIOR;
  for (let z = whA.z0 + 5; z < whA.z1 - 2; z += 6) {
    L.box(-42.5, -41.5, 0, whA.h - 0.6, z - 0.5, z + 0.5, { color: 0x3b434e, bucket: 'concrete' });
  }
  // racking
  for (let i = 0; i < 5; i++) {
    const z = -22 + i * 5.5;
    L.box(-62, -52, 0, 3.6, z, z + 1.6, { color: 0x4a5158, bucket: 'metal' });
    L.box(-50, -44, 0, 3.6, z, z + 1.6, { color: 0x4a5158, bucket: 'metal' });
    L.box(-42, -38.5, 0, 2.4, z + 1.0, z + 2.4, { color: 0x4d4438, bucket: 'paint' });
  }
  // Bay 3 office (north-east corner, holds the manifest)
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
  // office interior: desk, cabinet, whiteboard
  L.box(-32.6, -30.2, 0, 0.78, -24.4, -22.6, { color: 0x5a4a37, bucket: 'paint' });
  L.box(-32.6, -30.2, 0.78, 0.84, -24.6, -22.4, { color: 0x6b5842, bucket: 'paint', collide: false });
  L.box(-24.4, -23.0, 0, 1.9, -25.0, -23.4, { color: 0x4b5560, bucket: 'metal' });
  L.box(-31.0, -28.4, 1.1, 2.0, -25.2, -25.0, { color: 0xd8dde2, bucket: 'paint', collide: false });
  L.cyl(-25.6, 0.3, -19.4, 0.32, 0.6, { color: 0x2f363d, collide: true, lowPoly: true });
  L.sky = 1;
  // signage
  L.sign('VOLKERSTADT LOGISTIK', 'BAY 3 · GENERAL CARGO', -20.1, 7.2, -11, 12, 3, Math.PI / 2, { code: 'MPA-03' });
  L.sign('BAY 3', 'ENTRANCE B · NO ADMITTANCE', -20.2, 4.6, 1.6, 6, 1.5, Math.PI / 2, { accent: '#e8c247', code: 'ENT-3B' });

  /* ---------------- Cold store KÜHLHAUS ---------------- */
  const whB = { x0: 18, x1: 62, z0: 6, z1: 40, h: 8 };
  L.sky = SKY_INTERIOR;
  L.box(whB.x0, whB.x1, 0, 0.14, whB.z0, whB.z1, { color: 0x2a3138, bucket: 'concrete', collide: false });
  L.sky = 1;
  const whBC = 0x39424c;
  L.wallX(whB.x0 + 0.3, 0.6, whB.z0, whB.z1, 0, whB.h,
    [{ from: 18.5, to: 23.5, sill: 0, head: 3.2, glass: false }], whBC);
  L.wallX(whB.x1 - 0.3, 0.6, whB.z0, whB.z1, 0, whB.h, [], whBC);
  L.wallZ(whB.z0 + 0.3, 0.6, whB.x0, whB.x1, 0, whB.h,
    [{ from: 33.5, to: 38.5, sill: 0, head: 3.2, glass: false }], whBC);
  L.wallZ(whB.z1 - 0.3, 0.6, whB.x0, whB.x1, 0, whB.h, [], whBC);
  L.box(whB.x0 - 0.4, whB.x1 + 0.4, whB.h, whB.h + 0.6, whB.z0 - 0.4, whB.z1 + 0.4, { color: 0x20262d, bucket: 'metal' });
  // cold store racking and pallets
  L.sky = SKY_INTERIOR;
  for (let i = 0; i < 4; i++) {
    const z = 12 + i * 7;
    L.box(30, 44, 0, 4.2, z, z + 1.8, { color: 0x515a63, bucket: 'metal' });
    L.box(46, 58, 0, 4.2, z, z + 1.8, { color: 0x515a63, bucket: 'metal' });
  }
  L.sky = 1;
  L.sign('EISWERK KÜHLHAUS', 'COLD STORE · −24 °C', 17.7, 6.2, 12, 11, 2.8, -Math.PI / 2, { code: 'CS-2', accent: '#7fd6ff' });

  /* ---------------- Dispatch building ---------------- */
  const dp = { x0: 22, x1: 54, z0: -42, z1: -20, h: 6.6 };
  L.sky = SKY_INTERIOR;
  L.box(dp.x0, dp.x1, 0, 0.16, dp.z0, dp.z1, { color: 0x2f363e, bucket: 'concrete', collide: false });
  L.sky = 1;
  const dpC = 0x3c4550;
  // west facade: faces the yard, windows for observation from outside
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
  // south facade: main entrance + window band
  L.wallZ(dp.z1 - 0.25, 0.5, dp.x0, dp.x1, 0, dp.h, [
    { from: 25.6, to: 29.6, sill: 0, head: 3.0, glass: false },
    { from: 31.6, to: 36.6, sill: 1.3, head: 3.2, glass: true },
    { from: 40.4, to: 45.4, sill: 1.3, head: 3.2, glass: true },
    { from: 47.4, to: 52.4, sill: 1.3, head: 3.2, glass: true },
  ], dpC);
  L.box(dp.x0 - 0.35, dp.x1 + 0.35, dp.h, dp.h + 0.45, dp.z0 - 0.35, dp.z1 + 0.35, { color: 0x272d35, bucket: 'metal' });
  // interior partition (west: admin / east: ops room)
  L.sky = SKY_INTERIOR;
  L.wallX(38.7, 0.6, dp.z0 + 0.5, dp.z1 - 0.5, 0, dp.h - 0.6,
    [{ from: -31.4, to: -28.6, sill: 0, head: 2.4, glass: false }], 0x363f49);
  // ops room interior
  L.box(41, 46, 0, 0.86, -34.5, -32.2, { color: 0x4c5762, bucket: 'metal' });
  L.box(48, 53, 0, 0.86, -33.0, -30.6, { color: 0x4c5762, bucket: 'metal' });
  L.box(44, 50, 0.86, 1.36, -39.4, -38.2, { color: 0x2b333c, bucket: 'metal' }); // console
  L.box(41.2, 43.0, 1.0, 1.9, -34.8, -34.4, { color: 0x9fe6ff, bucket: 'metal', collide: false });
  L.box(48.4, 50.2, 1.0, 1.9, -35.2, -34.8, { color: 0x9fe6ff, bucket: 'metal', collide: false });
  L.box(44.4, 49.6, 1.36, 1.5, -39.2, -38.4, { color: 0x7fd0ff, bucket: 'metal', collide: false });
  // admin side
  L.box(24, 30, 0, 0.8, -38, -35.6, { color: 0x5a4a37, bucket: 'paint' });
  L.box(24, 30, 0, 0.8, -30, -27.6, { color: 0x5a4a37, bucket: 'paint' });
  L.box(31, 33, 0, 2.0, -41.2, -39.8, { color: 0x4b5560, bucket: 'metal' });
  L.sky = 1;
  L.sign('MERIDIAN PORT AUTHORITY', 'PORT DISPATCH · OPS', 26.5, 4.0, -19.6, 10, 2.6, 0, { code: 'OP-D1' });
  L.sign('TALOS SICHERHEIT', 'NIGHT WATCH · 24H', 55.6, 3.2, -30, 7, 2, Math.PI / 2, { code: 'SEC-07', accent: '#e8c247' });

  /* ---------------- Container yard ---------------- */
  const CONT_COLORS = [0x3c5a52, 0x6b4a3a, 0x39506b, 0x5c5f66, 0x6d6238, 0x47394f];
  const container = (x, z, rot, levels, ci) => {
    const LEN = 12.2, WID = 2.44, HGT = 2.59;
    const color = CONT_COLORS[ci % CONT_COLORS.length];
    for (let l = 0; l < levels; l++) {
      const shade = ci % 3 === 0 ? color : color;
      L.rotBox(x, HGT * l + HGT / 2, z, LEN, HGT - 0.09, WID, rot, {
        color: shade, bucket: 'container', tag: 'container',
      });
    }
    return { x, z, rot, levels };
  };
  const containers = [];
  // west wall column (along Z)
  containers.push(container(-9.2, -46, Math.PI / 2, 2, 0));
  containers.push(container(-9.2, -32, Math.PI / 2, 2, 2));
  containers.push(container(-9.2, -18, Math.PI / 2, 1, 4));
  containers.push(container(-9.2, -5, Math.PI / 2, 2, 1));
  // east wall column
  containers.push(container(9.2, -50, Math.PI / 2, 2, 3));
  containers.push(container(9.2, -36, Math.PI / 2, 2, 5));
  containers.push(container(9.2, -22, Math.PI / 2, 1, 2));
  containers.push(container(9.2, -9, Math.PI / 2, 2, 0));
  // outer stacks
  containers.push(container(-15.4, -14, 0, 2, 4));
  containers.push(container(-15.4, -11, 0, 1, 5));
  containers.push(container(14.2, -44, 0, 1, 1));
  containers.push(container(14.2, -58, 0, 2, 3));
  containers.push(container(-15.0, -58, 0, 1, 2));
  containers.push(container(-27.0, -58, 0, 2, 5));
  // loose stacks outside the yard
  containers.push(container(20.0, 0.5, 0, 2, 0));
  containers.push(container(33.0, 0.5, 0, 1, 3));
  containers.push(container(-30.0, 12.0, Math.PI / 2, 2, 1));
  containers.push(container(-14.0, 16.0, 0, 2, 4));
  containers.push(container(0.0, 16.0, Math.PI / 2, 2, 2));
  containers.push(container(12.0, 22.0, 0, 1, 5));
  containers.push(container(-40.0, 22.0, Math.PI / 2, 1, 0));
  containers.push(container(34.0, 46.0, 0, 2, 3));
  containers.push(container(46.0, 44.0, Math.PI / 2, 2, 1));
  // prominent number decals
  const codes = ['KRGU 214 388-7', 'KRGU 771 042-3', 'KRGU 508 619-1', 'KRGU 330 774-5', 'KRGU 662 190-8'];
  /* stencilled lettering only: transparent, pulled towards the camera so it never z-fights the corrugated panel */
  const decalMat = new THREE.MeshStandardMaterial({
    roughness: 0.62, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const decalGeo = new THREE.PlaneGeometry(11.4, 2.1);   // every decal is the same size, so the geometry is shared
  containers.slice(0, 9).forEach((c, i) => {
    const t = TX.containerCodeTexture('#' + new THREE.Color(CONT_COLORS[i % 6]).getHexString(), codes[i % codes.length]);
    const mm = decalMat.clone(); mm.map = t;
    for (let side = 0; side < 2; side++) {
      const m = new THREE.Mesh(decalGeo, mm);
      /* The decal sits on the long side, facing out. A rotated (π/2) container runs along Z, so its long sides
         face ±X; an unrotated one runs along X with sides facing ±Z. The original code had the two rotations
         swapped, which stood every decal on edge across the lane as an 11 m floating card. */
      const off = (2.44 / 2 + 0.01) * (side ? 1 : -1);
      m.position.set(c.x + (c.rot ? off : 0), 1.3, c.z + (c.rot ? 0 : off));
      m.rotation.y = c.rot ? (side ? Math.PI / 2 : -Math.PI / 2) : (side ? 0 : Math.PI);
      scene.add(m);
    }
  });

  /* ---------------- Gantry crane ---------------- */
  const craneZ0 = -62.5, craneZ1 = -50.5;
  for (const cz of [craneZ0, craneZ1]) {
    L.box(-30.0, -28.2, 0, 17, cz - 0.9, cz + 0.9, { color: 0x6c757e, bucket: 'metal' });
    L.box(28.2, 30.0, 0, 17, cz - 0.9, cz + 0.9, { color: 0x6c757e, bucket: 'metal' });
    // travel wheels
    for (const lx of [-29.1, 29.1]) {
      for (const dz of [-2.4, 2.4]) {
        L.cyl(lx, 0.55, cz + dz, 0.55, 0.6, { color: 0x2b3036, collide: false, lowPoly: true });
      }
    }
  }
  L.box(-31, 31, 16.4, 17.4, craneZ0 - 1.2, craneZ1 + 1.2, { color: 0x6c757e, bucket: 'metal' });
  L.box(-31, 31, 17.4, 18.0, -60.0, -53.0, { color: 0x59626b, bucket: 'metal', collide: false });
  // spreader
  L.box(-2.2, 2.2, 12.4, 14.0, -58.6, -54.4, { color: 0xb0563a, bucket: 'metal', collide: false });
  L.box(-0.35, 0.35, 14.0, 16.4, -56.9, -56.2, { color: 0x39424a, bucket: 'metal', collide: false });
  L.box(-0.35, 0.35, 14.0, 16.4, -54.9, -54.2, { color: 0x39424a, bucket: 'metal', collide: false });
  L.sign('NORDBRÜCKE CRANE CO.', 'GANTRY 04 · SWL 40 T', -28.6, 12.0, -56.5, 9, 2.4, -Math.PI / 2, { code: 'CR-04', accent: '#ffd479' });

  /* ---------------- Freighter (distant silhouette) ---------------- */
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
  /* geometry and material hoisted out of the loop: previously 5 iterations each built identical BoxGeometry+Material */
  const mastGeo = new THREE.BoxGeometry(0.6, 12, 0.6);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: .8, metalness: .4 });
  for (let i = 0; i < 5; i++) {
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(-60 + i * 22, 15, -104);
    scene.add(mast);
  }
  const shipName = new THREE.Mesh(new THREE.PlaneGeometry(30, 3),
    new THREE.MeshStandardMaterial({
      map: TX.signTexture('SOLSTICE VIGIL', 'HANSA MERIDIAN SHIPPING', { bg: '#0b1218', glow: false }),
      emissive: 0x223038, emissiveIntensity: 0.4, roughness: .8,
    }));
  shipName.position.set(-6, 6, -92.8);
  scene.add(shipName);

  /* ---------------- Gatehouse / props ---------------- */
  L.box(11, 17.4, 0, 3.2, 38, 43.6, { color: 0x39424c });
  L.box(11, 17.4, 0.0, 0.2, 38, 43.6, { color: 0x2c333c, collide: false, bucket: 'concrete' });
  L.box(10.6, 17.8, 3.2, 3.6, 37.6, 44.0, { color: 0x272d35, bucket: 'metal', collide: false });
  L.box(11.0, 17.4, 1.1, 2.6, 37.9, 38.0, { bucket: 'glass', collide: true, opaque: false, tag: 'glass' });
  L.sign('TALOS SICHERHEIT', 'GATE 1 · SOUTH', 10.7, 2.2, 40.8, 3.4, 1.1, -Math.PI / 2, { code: 'G1', glow: false });
  // gate barriers and bollards
  L.box(-7.4, -5.6, 0, 1.1, 49.4, 50.6, { color: 0x3a4249, bucket: 'concrete' });
  L.box(5.6, 7.4, 0, 1.1, 49.4, 50.6, { color: 0x3a4249, bucket: 'concrete' });
  for (const bx of [-9, -3, 3, 9]) {
    L.cyl(bx, 0.6, 47.4, 0.55, 1.2, { color: 0xb9bcc0, collide: true, lowPoly: true });
  }
  // APC (exfil point)
  const apc = { x: 0, z: 54 };
  L.rotBox(apc.x, 1.35, apc.z, 7.4, 2.5, 2.9, 0, { color: 0x2f3a35, bucket: 'paint', tag: 'vehicle' });
  L.rotBox(apc.x, 3.0, apc.z + 0.1, 3.2, 1.1, 2.3, 0, { color: 0x333f39, bucket: 'paint', tag: 'vehicle' });
  L.rotBox(apc.x - 1.0, 3.75, apc.z, 1.4, 0.5, 1.4, 0, { color: 0x2a332e, bucket: 'paint', collide: false });
  for (const wx of [-2.6, 2.6]) for (const wz of [-1.55, 1.55]) {
    L.cyl(apc.x + wx, 0.6, apc.z + wz, 0.6, 0.42, { color: 0x12161a, collide: false, lowPoly: true });
  }
  L.sign('MPA', 'TACTICAL UNIT', apc.x - 3.75, 1.8, apc.z, 2.6, 0.9, -Math.PI / 2, { glow: true, code: 'R-04' });

  // forklift
  const fkX = 3.4, fkZ = -29;
  L.rotBox(fkX, 0.75, fkZ, 2.6, 1.5, 1.5, 0.35, { color: 0xc08a2e, bucket: 'paint', tag: 'prop' });
  L.rotBox(fkX + 0.2, 2.1, fkZ - 0.1, 1.5, 1.4, 1.2, 0.35, { color: 0x2a3038, bucket: 'metal', tag: 'prop', collide: false });
  L.rotBox(fkX + 1.6, 1.5, fkZ + 0.6, 0.35, 3.0, 1.6, 0.35, { color: 0x3d444c, bucket: 'metal', collide: false });
  for (const wx of [-0.7, 0.9]) for (const wz of [-0.8, 0.8]) {
    L.cyl(fkX + wx * 0.9, 0.42, fkZ + wz * 0.9, 0.42, 0.32, { color: 0x11151a, collide: false, lowPoly: true });
  }
  // pallets / drums / cable reels / tyres
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

  /* ---------------- Street lamps ---------------- */
  const lampSpots = [
    [-17.5, -52, 0], [16, -52, 0], [-17.5, -26, 0], [16, -26, 0],
    [-17.5, 2, 0], [16, 2, 0], [0, 22, 0], [-34, 12, 0],
    [46, -46, 0], [-30, 46, 0], [22, 44, 0],
  ];
  /* The additive glow sprites fake lamp glow for the no-post path. With post on, bloom produces the glow from
     the lamp heads themselves and the sprites would stack a second, hard-edged disc on top (see setPostGlow). */
  const glowSprites = [];
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
    const sp = new THREE.Sprite(lampGlowMat);   // all 11 lamp glows are identical, no per-lamp clone needed
    sp.position.set(x, 9.0, z);
    sp.scale.set(7, 7, 1);
    scene.add(sp);
    glowSprites.push(sp);
  });

  /* ---------------- Wetness ----------------
     The 46 hard-edged puddle discs are gone: their positions now feed the ground's wetness mask as soft standing
     water (one draw call and one transparent sort fewer). The rng sequence is consumed exactly as before, so every
     later random placement is unchanged. */
  {
    const N = 46, puddles = [];
    for (let i = 0; i < N; i++) {
      const cx = rng.range(-68, 68), cz = rng.range(-62, 48);
      const r = rng.range(0.7, 3.6);
      const phi = rng.range(0, 6.28), sy = rng.range(0.5, 1.0);
      puddles.push({ x: cx, z: cz, r, phi, sy });
    }
    /* tyre tracks: the yard lanes and the forklift's working area */
    const tracks = [];
    for (const x of [-4.2, -2.6, 2.6, 4.2]) tracks.push({ x0: x, z0: 48, x1: x + 0.4, z1: -60, w: 0.35, a: 0.35 });
    for (const x of [-14.2, -12.8, 12.8, 14.2]) tracks.push({ x0: x, z0: 8, x1: x, z1: -60, w: 0.3, a: 0.25 });
    tracks.push({ x0: 1, z0: -24, x1: 7, z1: -34, w: 0.9, a: 0.4 });
    const wet = TX.wetnessMask(puddles, tracks);
    /* plane UV → mask: u = (x + 200)/400 so mask_u = (x − x0)/(x1 − x0) = u·S/W − (x0 + S/2)/W, likewise for v
       (v = 0 at world z = +200, mask row 0 = z0 with flipY off) */
    const E = TX.WET_EXTENT, S = GROUND_SIZE, W = E.x1 - E.x0, D = E.z1 - E.z0;
    wet.repeat.set(S / W, -S / D);
    wet.offset.set(-(E.x0 + S / 2) / W, (S / 2 - E.z0) / D);
    mats.asphalt.roughnessMap = wet;
    mats.asphalt.clearcoatMap = wet;
    mats.asphalt.clearcoatRoughnessMap = wet;
  }

  /* ---------------- Ground markings ----------------
     Worn thermoplastic paint: lit like any other surface (it was an unlit MeshBasicMaterial at 16% opacity, i.e. a
     constant-brightness overlay that ignored the lamps), merged into one mesh. Lane lines run the length of the yard. */
  {
    const lineTex = TX.lineTexture();
    lineTex.repeat.set(1, 108 / 16);
    const lineMat = new THREE.MeshStandardMaterial({
      map: lineTex, transparent: true, roughness: 0.55, metalness: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const parts = [];
    for (let i = -3; i <= 3; i++) {
      const g = new THREE.PlaneGeometry(0.4, 108);
      g.rotateX(-Math.PI / 2); g.translate(i * 5.6, 0.015, -8);
      parts.push(g);
    }
    const merged = mergePlanes(parts);
    parts.forEach((g) => g.dispose());
    scene.add(new THREE.Mesh(merged, lineMat));
  }

  /* ---------------- Lights ----------------
     Exposure (renderer.toneMappingExposure in game.js) is the one global; everything below is set relative to it
     and to each other, in layers:
       1. sky   — the environment map (SKY_STOPS) is the main ambient: cold zenith, sodium-orange horizon band.
                  The hemisphere light repeats that split for surfaces facing straight up/down.
       2. bounce — wet ground throws pool light back up onto container undersides and flanks:
                  three weak, wide, upward directionals tinted to the sodium colour, a few percent of the key.
       3. key   — sodium lamps as wide-penumbra spotlights pointing down (a lamp head emits into the lower
                  hemisphere only), inverse-square falloff with no distance cutoff: the hard 36 m window of the
                  old point lights is what drew the elliptical rims.
       4. far fill — a few cheap, low-decay points high above the yard: sodium light carried tens of metres
                  by the fog and the wet asphalt.
       5. moon  — a dim, cold, fog-diffused sky key; it keeps the only shadow map (grounding / contact shadows). */
  const hemi = new THREE.HemisphereLight(0x6f86a6, 0x8a5a33, HEMI_INTENSITY);
  scene.add(hemi);

  const bounce = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const d = new THREE.DirectionalLight(SODIUM, BOUNCE_INTENSITY);
    /* positioned below the ground looking up: lights faces whose normals point down or sideways */
    d.position.set(Math.cos(a), -0.7, Math.sin(a));
    d.target.position.set(0, 0, 0);
    scene.add(d); scene.add(d.target);
    bounce.push(d);
  }

  const moon = new THREE.DirectionalLight(0x9db6d4, MOON_INTENSITY);
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
  moon.shadow.radius = 3;
  scene.add(moon);
  scene.add(moon.target);

  const lampLights = [];
  [0, 2, 3, 5, 6, 8].forEach((idx) => {
    const [x, z] = lampSpots[idx];
    /* angle 1.25 rad (~72° half-angle) with penumbra 0.9: the beam edge is a long ramp, not a rim;
       a 0.9 m lamp head is an area source, which a wide penumbra approximates */
    const sl = new THREE.SpotLight(SODIUM, LAMP_INTENSITY, 0, 1.25, 0.9, 2);
    sl.position.set(x, 8.85, z);
    sl.target.position.set(x, 0, z);
    scene.add(sl); scene.add(sl.target);
    lampLights.push(sl);
  });
  const farFill = [];
  for (const [x, z] of [[-6, -44], [6, -14], [6, 20]]) {
    const pl = new THREE.PointLight(SODIUM, FAR_FILL_INTENSITY, 80, 1.0);
    pl.position.set(x, 18, z);
    scene.add(pl);
    farFill.push(pl);
  }
  /* ---------------- Atmosphere: light shafts and motes ----------------
     Sea fog makes the sodium beams visible as soft cones. One merged mesh (one draw call) of narrow cones
     (the bright core of each beam, ~31° half-angle) from the six lit lamp heads: additive, depth-tested so
     geometry in front hides them, never writing depth. Brightness falls to zero by 70% of the way down (~4.3 m
     above the ground, clear of the stacks beside the lamps), so a cone never visibly meets the ground or a box, and fades at its silhouette
     (rim falloff) so it reads as a volume, not a surface. Slow noise drifting through it is the fog moving. */
  const atmo = { time: { value: 0 } };
  {
    const shaftNoise = TX.fogNoiseTexture();
    const parts = [];
    for (const sl of lampLights) {
      const H = 6.2, R = Math.tan(0.55) * H;
      const g = new THREE.ConeGeometry(R, H, 28, 1, true);
      g.translate(sl.position.x, sl.position.y - 0.25 - H / 2, sl.position.z);
      parts.push(g);
    }
    const shaftGeo = mergePlanes(parts);
    parts.forEach((g) => g.dispose());
    const shaftMat = new THREE.ShaderMaterial({
      uniforms: { time: atmo.time, tNoise: { value: shaftNoise }, color: { value: new THREE.Color(SODIUM).multiplyScalar(SHAFT_INTENSITY) } },
      vertexShader: `
        varying vec3 vWorld; varying vec3 vNormalW; varying float vH;
        void main() {
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz; vNormalW = normalize( mat3( modelMatrix ) * normal ); vH = 1.0 - uv.y;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform float time; uniform sampler2D tNoise; uniform vec3 color;
        varying vec3 vWorld; varying vec3 vNormalW; varying float vH;
        void main() {
          float along = smoothstep( 0.0, 0.05, vH ) * pow( max( 1.0 - vH / 0.7, 0.0 ), 1.4 );
          vec3 V = normalize( cameraPosition - vWorld );
          float facing = abs( dot( normalize( vNormalW ), V ) );
          float rim = pow( facing, 1.3 );
          float n = texture2D( tNoise, vWorld.xz * 0.11 + vec2( time * 0.013, time * 0.006 ) ).r * 0.6
                  + texture2D( tNoise, vec2( vWorld.x * 0.05 - time * 0.004, vWorld.y * 0.07 ) ).r * 0.4;
          gl_FragColor = vec4( color * along * rim * ( 0.45 + 0.9 * n ), 1.0 );
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const shafts = new THREE.Mesh(shaftGeo, shaftMat);
    shafts.renderOrder = 10;
    scene.add(shafts);

    /* Motes: a few airborne droplets/dust around the lit lamps, visible only when you look past them towards the
       lamp (strong forward scattering), so most of the time nobody sees them at all. */
    const mrng = makeRng(0x4d07e5);
    const PER = 26, lampPos = lampLights.map((l) => l.position.clone());
    const mp = new Float32Array(lampPos.length * PER * 3), lamp = new Float32Array(lampPos.length * PER), ph = new Float32Array(lampPos.length * PER);
    let k = 0;
    lampPos.forEach((lp, li) => {
      for (let i = 0; i < PER; i++, k++) {
        const a = mrng.next() * Math.PI * 2, r = Math.sqrt(mrng.next()) * 4.5;
        mp[k * 3] = lp.x + Math.cos(a) * r; mp[k * 3 + 1] = 1.2 + mrng.next() * 6.5; mp[k * 3 + 2] = lp.z + Math.sin(a) * r;
        lamp[k] = li; ph[k] = mrng.next() * 100;
      }
    });
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('lampIndex', new THREE.BufferAttribute(lamp, 1));
    mg.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    const moteMat = new THREE.ShaderMaterial({
      uniforms: { time: atmo.time, lamps: { value: lampPos }, color: { value: new THREE.Color(SODIUM).multiplyScalar(MOTE_INTENSITY) } },
      vertexShader: `
        uniform float time; uniform vec3 lamps[ ${lampPos.length} ];
        attribute float lampIndex; attribute float phase;
        varying float vBright;
        void main() {
          vec3 p = position + vec3( sin( time * 0.07 + phase ), sin( time * 0.05 + phase * 1.7 ) * 0.6, cos( time * 0.06 + phase * 0.6 ) ) * 0.35;
          vec3 L = lamps[ int( lampIndex ) ];
          vec3 toLamp = normalize( L - p ), toCam = normalize( cameraPosition - p );
          float fwd = pow( max( dot( -toCam, toLamp ), 0.0 ), 8.0 );        // forward scatter: only against the light
          float dl = distance( p, L );
          vBright = fwd / ( 1.0 + dl * dl * 0.08 );
          vec4 mv = viewMatrix * vec4( p, 1.0 );
          gl_PointSize = clamp( 26.0 / -mv.z, 1.0, 4.0 );
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 color; varying float vBright;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep( 0.5, 0.0, length( c ) );
          gl_FragColor = vec4( color * vBright * a, 1.0 );
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const motes = new THREE.Points(mg, moteMat);
    motes.frustumCulled = false;
    motes.renderOrder = 11;
    scene.add(motes);
  }

  // building interior fill
  const fillA = new THREE.PointLight(0xcfe6ff, 42, 34, 1.9); fillA.position.set(-46, 6.5, -10); scene.add(fillA);
  const fillD = new THREE.PointLight(0xa8dcff, 46, 34, 1.9); fillD.position.set(44, 5.0, -32); scene.add(fillD);
  const fillB = new THREE.PointLight(0xbfe2ff, 36, 32, 1.9); fillB.position.set(36, 6.0, 22); scene.add(fillB);
  const fillOff = new THREE.PointLight(0xffe0b0, 16, 16, 2.0); fillOff.position.set(-28, 2.7, -21.4); scene.add(fillOff);

  /* ---------------- Build batches ---------------- */
  const batchMeshes = L.batch.build(mats, scene, true, true);

  /* ---------------- Cover points ---------------- */
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
      const hits = grid.queryCircle(x, z, 0.55, _coverScratch);
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

  /* ---------------- Objectives / zones ---------------- */
  const objectives = {
    manifest: { x: -29.4, z: -23.4, label: 'Manifest', zone: 'Bay 3 office' },
    evidence: { x: 47.0, z: -36.6, label: 'Evidence', zone: 'Dispatch' },
    extract: { x: 0, z: 53, label: 'Exfil', zone: 'APC · south gate' },
  };
  const safeZone = { x0: -10, x1: 10, z0: 42, z1: 50, label: 'South gate RV' };

  /* short is for the minimap (little room, short names only); label is for the tactical map */
  const zones = [
    { x0: -72, x1: 72, z0: 42, z1: 50, label: 'GATE 1 · SOUTH', short: 'GATE', kind: 'gate' },
    { x0: -18, x1: 18, z0: -60, z1: 8, label: 'CONTAINER YARD', short: 'YARD', kind: 'yard' },
    { x0: -64, x1: -20, z0: -26, z1: 4, label: 'BAY 3', short: 'BAY 3', kind: 'building' },
    { x0: -34, x1: -21.2, z0: -25.4, z1: -17.4, label: 'BAY 3 OFFICE', short: 'OFFICE', kind: 'room' },
    { x0: 18, x1: 62, z0: 6, z1: 40, label: 'COLD STORE · KÜHLHAUS', short: 'COLD', kind: 'building' },
    { x0: 22, x1: 54, z0: -42, z1: -20, label: 'DISPATCH', short: 'DISPATCH', kind: 'building' },
    { x0: 39, x1: 54, z0: -42, z1: -20, label: 'OPS ROOM', short: 'OPS', kind: 'room' },
    { x0: -72, x1: 72, z0: -66, z1: -50, label: 'BERTH 3', short: 'BERTH 3', kind: 'quay' },
  ];

  /* ---------------- Spawns ---------------- */
  const spawns = {
    player: { x: 0, z: 43.5, yaw: 0 },
    squad: [
      { x: -2.6, z: 46.4, yaw: 0.12 },
      { x: 2.6, z: 46.4, yaw: -0.12 },
      { x: -4.6, z: 48.6, yaw: 0.2 },
      { x: 4.6, z: 48.6, yaw: -0.2 },
    ],
  };

  /* ---------------- Suspects ---------------- */
  const suspects = [
    { id: 'S1', name: 'EGRET-1', patrol: [[-4, -50], [5, -44], [-6, -38]], speed: 1.25 },
    { id: 'S2', name: 'EGRET-2', patrol: [[6, -30], [-2, -23], [6, -14]], speed: 1.15 },
    { id: 'S3', name: 'EGRET-3', patrol: [[-32, -10], [-52, -8], [-48, 0], [-26, -5]], speed: 1.1 },
    { id: 'S4', name: 'EGRET-4', post: [-24.6, -20.6], speed: 1.0, elite: true },
    { id: 'S5', name: 'EGRET-5', post: [41.6, -25.6], speed: 1.0 },
    { id: 'S6', name: 'EGRET-6', patrol: [[49, -38], [26, -38], [27, -24]], speed: 1.2 },
    { id: 'S7', name: 'EGRET-7', patrol: [[-14, -57], [10, -57], [16, -47]], speed: 1.25 },
    { id: 'S8', name: 'EGRET-8', patrol: [[24, 12], [52, 14], [50, 34], [26, 32]], speed: 1.1 },
    { id: 'S9', name: 'EGRET-9', post: [19, 34], speed: 1.0, rear: true },
  ];

  /* ---------------- Civilians ---------------- */
  const civilians = [
    { id: 'C1', x: 1.5, z: -27.0, label: 'Night stevedore' },
    { id: 'C2', x: -46.0, z: -12.0, label: 'Bay tallyman' },
    { id: 'C3', x: 34.0, z: 25.0, label: 'Cold-store attendant' },
    { id: 'C4', x: -10.5, z: 15.0, label: 'Yard patrolman' },
  ];

  /* ---------------- Update ---------------- */
  let t = 0;
  /* Shadow map texel size: the shadow camera must snap to it when following the camera.
     Without snapping the light moves by sub-texel amounts every frame, so shadow edges shimmer
     and crawl against static geometry. */
  const SHADOW_TEXEL = (moon.shadow.camera.right - moon.shadow.camera.left) / moon.shadow.mapSize.x;

  function update(dt, camPos) {
    t += dt;
    skyDome.position.copy(camPos);
    if (!REDUCED_MOTION) atmo.time.value = t;      // simulation time only: deterministic under ?test=1
    /* Shadow camera follow: the anchor snaps to the texel grid and the light/target offset stays constant
       (directional light, fixed direction), so the shadow map content doesn't swim frame to frame. */
    const ax = Math.round(camPos.x / SHADOW_TEXEL) * SHADOW_TEXEL;
    const az = Math.round(camPos.z / SHADOW_TEXEL) * SHADOW_TEXEL;
    moon.position.set(ax + 38, 62, az - 26);
    moon.target.position.set(ax, 0, az);
    moon.target.updateMatrixWorld();
  }

  return {
    grid, level: L, batchMeshes, mats, covers, coverIdx,
    objectives, zones, safeZone, spawns, suspects, civilians, containers,
    skyTex, envRT,                       // not in the scene graph; freed by disposeMission
    lights: { hemi, moon, lampLights, farFill, bounce, fills: [fillA, fillB, fillD] },
    update,
    setPostGlow(on) { for (const sp of glowSprites) sp.visible = !on; },
    /* clock driving shaft noise and mote drift (simulation seconds; stays 0 under prefers-reduced-motion) */
    get atmosphereTime() { return atmo.time.value; },
    /* sky visibility at a ground position: building interiors see ~22% of the sky (used by the viewmodel) */
    skyAt(x, z) {
      for (const b of INTERIORS) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return SKY_INTERIOR;
      return 1;
    },
    bounds: WORLD.bounds,
  };
}
