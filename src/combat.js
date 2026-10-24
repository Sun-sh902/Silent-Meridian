/* ============================================================
   combat.js — ballistics, hit detection, projectiles and visual effects
   ============================================================ */
import * as THREE from 'three';
import { feel } from './feel.js';

/* ---------------- Ray vs AABB ---------------- */
/* Teams: blue = player + squad, red = suspects, green = civilians.
   Friendly fire is off: same-team rounds pass straight through without registering a hit. */
export function teamOf(a) {
  if (!a) return null;
  if (a.kind === 'player' || a.kind === 'squad') return 'blue';
  if (a.kind === 'suspect') return 'red';
  return 'green';
}
export function sameTeam(a, b) {
  return !!a && !!b && teamOf(a) === teamOf(b);
}

/* Ray vs AABB (scalar version).
   Previously four temp arrays (o/d/lo/hi) drove a per-axis loop, allocating 4 arrays per call;
   this runs for every shot, every pellet and every candidate box,
   so one shotgun blast (9 pellets) could allocate over a thousand arrays. All locals are scalars now. */
export function rayAABB(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0, tmax = Infinity;
  let t1, t2, tmp;
  // ---- X ----
  if (Math.abs(dx) < 1e-7) { if (ox < b.min.x || ox > b.max.x) return -1; }
  else {
    t1 = (b.min.x - ox) / dx; t2 = (b.max.x - ox) / dx;
    if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // ---- Y ----
  if (Math.abs(dy) < 1e-7) { if (oy < b.min.y || oy > b.max.y) return -1; }
  else {
    t1 = (b.min.y - oy) / dy; t2 = (b.max.y - oy) / dy;
    if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // ---- Z ----
  if (Math.abs(dz) < 1e-7) { if (oz < b.min.z || oz > b.max.z) return -1; }
  else {
    t1 = (b.min.z - oz) / dz; t2 = (b.max.z - oz) / dz;
    if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/* reused buffer: castRay uses it on every call, so it's a module-level singleton */
const _rayScratch = [];
const _rayBox = {
  min: { x: 0, y: 0, z: 0 },
  max: { x: 0, y: 0, z: 0 },
};

/** Nearest wall and actor along a ray */
export function castRay(game, ox, oy, oz, dx, dy, dz, maxDist, shooter) {
  const grid = game.world.grid;
  let wallT = null, wallBox = null;
  const scratch = _rayScratch;
  const step = 3.5;
  const n = Math.ceil(Math.min(maxDist, 150) / step);
  for (let s = 0; s <= n; s++) {
    const t0 = s * step;
    const px = ox + dx * t0, py = oy + dy * t0, pz = oz + dz * t0;
    grid.queryCircle(px, pz, step * 0.75, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const b = scratch[i];
      if (b.noCollide) continue;
      const t = rayAABB(ox, oy, oz, dx, dy, dz, b);
      if (t >= 0 && t <= maxDist && (wallT === null || t < wallT)) { wallT = t; wallBox = b; }
    }
    if (wallT !== null && wallT < t0 - step) break;
  }

  let best = null;
  for (const a of game.actors) {
    if (a === shooter || !a.alive) continue;
    if (shooter && sameTeam(shooter, a)) continue;   // friendly fire off: pass straight through
    const b = _rayBox;
    const r = a.radius;
    b.min.x = a.pos.x - r; b.max.x = a.pos.x + r;
    b.min.z = a.pos.z - r; b.max.z = a.pos.z + r;
    b.min.y = a.y; b.max.y = a.y + (a.crouch ? 1.25 : 1.85);
    if (!a.crouch) { b.min.y = a.y + 0.15; b.max.y = a.y + 1.9; }
    const t = rayAABB(ox, oy, oz, dx, dy, dz, b);
    if (t >= 0 && t <= maxDist) {
      if (wallT !== null && wallT < t) continue;
      if (!best || t < best.t) best = { actor: a, t };
    }
  }
  if (best) {
    best.point = { x: ox + dx * best.t, y: oy + dy * best.t, z: oz + dz * best.t };
    best.dist = best.t;
    return best;
  }
  if (wallT !== null && wallT <= maxDist) {
    return {
      wall: true, box: wallBox, dist: wallT,
      point: { x: ox + dx * wallT, y: oy + dy * wallT, z: oz + dz * wallT },
    };
  }
  return { dist: maxDist, point: { x: ox + dx * maxDist, y: oy + dy * maxDist, z: oz + dz * maxDist }, miss: true };
}

/* reused buffers: projectile ground checks and flashbang LOS sampling, no new arrays per call */
const _projScratch = [];
const _losScratch = [];

/* ---------------- Effects manager ---------------- */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.tracers = [];
    this.sparks = [];
    this.decals = [];
    this.smoke = [];
    this.decalIdx = 0;

    const sparkCanvas = document.createElement('canvas');
    sparkCanvas.width = sparkCanvas.height = 64;
    const g = sparkCanvas.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,240,200,1)');
    grd.addColorStop(0.3, 'rgba(255,190,110,.7)');
    grd.addColorStop(1, 'rgba(255,140,60,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    this.sparkTex = new THREE.CanvasTexture(sparkCanvas);
    this.sparkTex.colorSpace = THREE.SRGBColorSpace;

    const cloudCanvas = document.createElement('canvas');
    cloudCanvas.width = cloudCanvas.height = 128;
    const g2 = cloudCanvas.getContext('2d');
    const grd2 = g2.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd2.addColorStop(0, 'rgba(220,228,235,.9)');
    grd2.addColorStop(0.5, 'rgba(190,200,210,.45)');
    grd2.addColorStop(1, 'rgba(160,175,190,0)');
    g2.fillStyle = grd2; g2.fillRect(0, 0, 128, 128);
    this.cloudTex = new THREE.CanvasTexture(cloudCanvas);
    this.cloudTex.colorSpace = THREE.SRGBColorSpace;

    // impact decal pool
    const decalGeo = new THREE.CircleGeometry(0.07, 6);
    const decalMat = new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.75, depthWrite: false });
    const decalInst = new THREE.InstancedMesh(decalGeo, decalMat, 140);
    decalInst.frustumCulled = false;
    decalInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decalMesh = decalInst;
    scene.add(decalInst);
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 140; i++) decalInst.setMatrixAt(i, this._hidden);
    decalInst.instanceMatrix.needsUpdate = true;

    this.muzzleLight = new THREE.PointLight(0xffcf95, 0, 14, 2);
    scene.add(this.muzzleLight);
    this.muzzleTimer = 0;

    /* ---- object pools ----
       Tracers and impact sparks used to create geometry+material+sprite on every shot/hit;
       one shotgun blast (9 pellets) created and destroyed over a thousand GPU objects.
       They are now preallocated up to a fixed cap and recycled; no GPU allocation at runtime. */
    this._tracerPool = [];
    this._tracerFree = [];
    this._sparkPool = [];
    this._sparkFree = [];
    /* reused matrix/vectors: impact() used to allocate Matrix4+Quaternion+2×Vector3 per call */
    this._m4 = new THREE.Matrix4();
    this._q0 = new THREE.Quaternion();
    this._v3 = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    const TRACER_MAX = 96, SPARK_MAX = 160;
    for (let i = 0; i < TRACER_MAX; i++) {
      /* each tracer needs its own geometry (endpoints differ),
         but all are allocated once at construction; runtime only rewrites vertices. */
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xffe0a8, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this._tracerPool.push({ m: line, mat, pos: geo.attributes.position });
      this._tracerFree.push(i);
    }
    for (let i = 0; i < SPARK_MAX; i++) {
      /* likewise: each spark needs its own material, or same-coloured sparks overwrite each other's opacity */
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.sparkTex, color: 0xffffff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      sp.visible = false;
      scene.add(sp);
      this._sparkPool.push(sp);
      this._sparkFree.push(i);
    }
  }

  tracer(from, to, color = 0xffe0a8) {
    // pool exhausted: drop this tracer (purely visual, 55 ms life, no information lost)
    if (!this._tracerFree.length) return;
    const idx = this._tracerFree.pop();
    const t = this._tracerPool[idx];
    t.pos.setXYZ(0, from.x, from.y, from.z);
    t.pos.setXYZ(1, to.x, to.y, to.z);
    t.pos.needsUpdate = true;
    if (t.mat.color.getHex() !== color) t.mat.color.setHex(color);
    t.mat.opacity = 0.85;
    t.m.visible = true;
    this.tracers.push({ i: idx, life: 0.055 });
  }

  impact(p, color = 0xffc98a, scale = 1) {
    if (this._sparkFree.length) {
      const idx = this._sparkFree.pop();
      const sp = this._sparkPool[idx];
      sp.material.color.setHex(color);
      sp.material.opacity = 1;
      sp.position.set(p.x, p.y, p.z);
      sp.scale.setScalar(0.5 * scale * feel.feedback.impactSparkScale);
      sp.visible = true;
      this.sparks.push({ i: idx, life: 0.20, max: 0.20 });
    }
    const d = this._m4;
    d.compose(this._v3.set(p.x, p.y - 0.02, p.z), this._q0, this._one);
    this.decalMesh.setMatrixAt(this.decalIdx, d);
    this.decalMesh.instanceMatrix.needsUpdate = true;
    this.decalIdx = (this.decalIdx + 1) % 140;
  }

  muzzle(p, intensity = 1, color = 0xffcf95) {
    this.muzzleLight.position.set(p.x, p.y, p.z);
    this.muzzleLight.color.setHex(color);
    this.muzzleLight.intensity = Math.max(this.muzzleLight.intensity, 22 * intensity);
    this.muzzleTimer = feel.feedback.muzzleFlashTime;
    if (!this._sparkFree.length) return;
    const idx = this._sparkFree.pop();
    const sp = this._sparkPool[idx];
    sp.material.color.setHex(color);
    sp.material.opacity = 1;
    sp.position.set(p.x, p.y, p.z);
    sp.scale.setScalar(1.1 * intensity);
    sp.visible = true;
    this.sparks.push({ i: idx, life: 0.06, max: 0.06 });
  }

  smokeCloud(x, y, z, radius, life = 16) {
    const group = new THREE.Group();
    const puffs = [];
    for (let i = 0; i < 7; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.cloudTex, color: 0xc8d4de, transparent: true, opacity: 0.42,
        depthWrite: false,
      }));
      const a = (i / 7) * 6.283;
      sp.position.set(Math.cos(a) * radius * 0.4, 1.0 + (i % 3) * 0.5, Math.sin(a) * radius * 0.4);
      sp.scale.setScalar(radius * 1.5);
      group.add(sp);
      puffs.push(sp);
    }
    group.position.set(x, y, z);
    this.scene.add(group);
    this.smoke.push({ group, puffs, x, z, r: radius * 0.85, life, max: life });
  }

  update(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      const slot = this._tracerPool[t.i];
      slot.mat.opacity = Math.max(0, t.life / 0.055) * 0.85;
      if (t.life <= 0) {
        slot.m.visible = false;              // back to the pool; not destroyed or reallocated
        this._tracerFree.push(t.i);
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      const k = Math.max(0, s.life / s.max);
      const sp = this._sparkPool[s.i];
      sp.material.opacity = k;
      sp.scale.multiplyScalar(1 + dt * 5);
      if (s.life <= 0) {
        sp.visible = false;
        this._sparkFree.push(s.i);
        this.sparks.splice(i, 1);
      }
    }
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const c = this.smoke[i];
      c.life -= dt;
      const age = 1 - c.life / c.max;
      const grow = 1 + age * 1.5;
      c.group.scale.setScalar(grow);
      const fade = c.life < 4 ? Math.max(0, c.life / 4) : Math.min(1, age * 4);
      for (const p of c.puffs) p.material.opacity = 0.40 * fade;
      if (c.life <= 0) {
        this.scene.remove(c.group);
        c.puffs.forEach((p) => p.material.dispose());
        this.smoke.splice(i, 1);
      }
    }
    if (this.muzzleTimer > 0) {
      this.muzzleTimer -= dt;
      /* dt-normalised decay: the old "×0.55 per frame" decayed 2.4× faster at 144 Hz than at 60 Hz,
         so muzzle flash brightness/duration varied with refresh rate. */
      if (this.muzzleTimer <= 0) this.muzzleLight.intensity = 0;
      else this.muzzleLight.intensity *= Math.exp(-dt * 35.8);   // equivalent to 0.55 at 60 fps
    }
  }

  /** Does smoke block the line between two points */
  smokeBlocks(ax, ay, az, bx, by, bz) {
    for (const c of this.smoke) {
      if (c.life < 2) continue;
      const r = c.r * c.group.scale.x;
      // point-to-segment distance (XZ plane) + height check
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((c.x - ax) * dx + (c.z - az) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const py = ay + (by - ay) * t;
      const d = Math.hypot(px - c.x, pz - c.z);
      if (d < r && py < 5.5) return true;
    }
    return false;
  }
}

/* ---------------- Projectiles ---------------- */
export function updateProjectiles(game, dt) {
  const { grid } = game.world;
  for (let i = game.projectiles.length - 1; i >= 0; i--) {
    const p = game.projectiles[i];
    p.fuse -= dt;
    if (p.rest) {
      p.spin += dt * 0.4;
    } else {
      p.vy -= 19 * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      // simple collision
      let hit = false;
      const cands = grid.queryPoint(nx, nz, _projScratch);
      for (const b of cands) {
        if (b.noCollide || b.max.y < 0.6) continue;
        if (nx > b.min.x - 0.1 && nx < b.max.x + 0.1 && nz > b.min.z - 0.1 && nz < b.max.z + 0.1 && ny < b.max.y && ny > b.min.y) { hit = true; break; }
      }
      if (ny <= 0.09) { p.y = 0.09; hit = true; }
      if (hit) {
        p.vx *= 0.22; p.vz *= 0.22; p.vy = 0;
        p.rest = true;
        p.y = Math.max(0.09, ny);
      } else {
        p.x = nx; p.y = ny; p.z = nz;
      }
      p.spin += dt * 9;
    }
    if (p.mesh) {
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.rotation.x += dt * 7;
      p.mesh.rotation.z += dt * 5;
    }
    if (p.fuse <= 0) {
      /* Order matters: mark and dequeue first, then detonate.
         Otherwise if detonate throws, a projectile with fuse<=0 stays in the array and
         detonates again next frame — creating audio nodes every frame and locking the main thread. */
      p.detonated = true;
      game.projectiles.splice(i, 1);
      try {
        detonate(game, p);
      } catch (err) {
        console.error('[SILENT MERIDIAN] projectile detonation failed (dequeued, will not retrigger)', err);
      }
      if (p.mesh) {
        /* projectile meshes are created per throw (player.throwGadget);
           remove without dispose leaks GPU resources. */
        game.scene.remove(p.mesh);
        if (p.mesh.geometry) p.mesh.geometry.dispose();
        if (p.mesh.material) p.mesh.material.dispose();
        p.mesh = null;
      }
    }
  }
}

/** Backstop: clean up any detonated or timed-out projectiles (normally the array is empty) */
export function sweepProjectiles(game) {
  const limit = 48;
  if (game.projectiles.length > limit) {
    for (let i = 0; i < game.projectiles.length - limit; i++) {
      const p = game.projectiles[i];
      if (p.mesh) {
        game.scene.remove(p.mesh);
        if (p.mesh.geometry) p.mesh.geometry.dispose();
        if (p.mesh.material) p.mesh.material.dispose();
        p.mesh = null;
      }
    }
    game.projectiles.splice(0, game.projectiles.length - limit);
  }
}

function detonate(game, p) {
  const fx = game.effects;
  if (game.stats) game.stats.detonations = (game.stats.detonations || 0) + 1;
  if (p.type === 'smoke') {
    fx.smokeCloud(p.x, 0, p.z, p.radius || 11, 18);
    game.log('Smoke out — line of sight blocked', 'warn');
    game.addMapEvent(p.x, p.z, 'Smoke', 'support');
    return;
  }
  if (p.type === 'breach') {
    fx.impact({ x: p.x, y: p.y, z: p.z }, 0xffd08a, 4);
    game.shake(0.9, 0.5);
    game.audio.boom(1.0);
    for (const a of game.actors) {
      const d = Math.hypot(a.pos.x - p.x, a.pos.z - p.z);
      if (d < 14) a.suppress(3.0, 1);
    }
    game.addMapEvent(p.x, p.z, 'Explosion', 'explosion');
    game.raiseAlarm('explosion');
    return;
  }
  // flashbang
  game.audio.flashbang();
  game.shake(0.35, 0.3);
  for (const a of game.actors) {
    if (!a.alive) continue;
    const dx = a.pos.x - p.x, dz = a.pos.z - p.z;
    const d = Math.hypot(dx, dz);
    const r = p.radius || 13;
    if (d > r) continue;
    const eye = { x: a.pos.x, y: a.y + 1.6, z: a.pos.z };
    if (game.world.grid && losBlockedQuick(game, p, eye)) continue;
    const k = 1 - d / r;
    a.blind = Math.max(a.blind || 0, 2.5 + k * 4.5);
    a.suppress(6, 2);
    if (a.kind === 'suspect') a.morale -= 0.55 * k;
  }
  if (game.player) {
    const d = Math.hypot(game.player.pos.x - p.x, game.player.pos.z - p.z);
    const r = p.radius || 13;
    if (d < r) {
      const k = 1 - d / r;
      game.player.blind = Math.max(game.player.blind || 0, 1.2 * k);
      // the whiteout must appear immediately (it used to flash only when the stun ended), and only touches opacity
      if (game.ui) game.ui.flash(0.30 + 0.55 * k);
    }
  }
  game.log('Flashbang — targets stunned', 'good');
  game.addMapEvent(p.x, p.z, 'Flashbang', 'explosion');
  game.raiseAlarm('flashbang');
}

function losBlockedQuick(game, from, to) {
  const steps = 10;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
    const list = game.world.grid.queryPoint(x, z, _losScratch);
    for (const b of list) {
      if (b.opaque === false) continue;
      if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z && y > b.min.y && y < b.max.y) return true;
    }
  }
  return false;
}
