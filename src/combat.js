/* ============================================================
   combat.js — 弹道、命中判定、投掷物与视觉特效
   ============================================================ */
import * as THREE from 'three';
import { feel } from './feel.js';

/* ---------------- 射线 vs AABB ---------------- */
/* 阵营划分：蓝=主角+队友，红=嫌疑人，绿=平民。
   友军伤害已关闭：同阵营的子弹直接穿过，不判定命中。 */
export function teamOf(a) {
  if (!a) return null;
  if (a.kind === 'player' || a.kind === 'squad') return 'blue';
  if (a.kind === 'suspect') return 'red';
  return 'green';
}
export function sameTeam(a, b) {
  return !!a && !!b && teamOf(a) === teamOf(b);
}

/* 射线 vs AABB（标量版）。
   此前用 4 个临时数组（o/d/lo/hi）做逐轴循环，每次调用分配 4 个数组；
   本函数在每次射击、每颗弹丸、每个候选盒子上都会被调用，
   一次霰弹枪射击（9 颗弹丸）就能产生上千次数组分配。这里全部改成局部标量。 */
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

/* 复用缓冲：castRay 每次调用都会用到，改成模块级单例，避免每次分配 */
const _rayScratch = [];
const _rayBox = {
  min: { x: 0, y: 0, z: 0 },
  max: { x: 0, y: 0, z: 0 },
};

/** 沿射线找最近的墙体与角色 */
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
    if (shooter && sameTeam(shooter, a)) continue;   // 友军伤害关闭：直接穿过
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

/* 复用缓冲：投掷物落地检测与闪光弹视线采样，避免每次新建数组 */
const _projScratch = [];
const _losScratch = [];

/* ---------------- 特效管理器 ---------------- */
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

    // 弹着贴花池
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

    /* ---- 对象池 ----
       曳光弹与弹着火花原先每次开火/命中都新建 geometry+material+sprite，
       一次霰弹枪射击（9 颗弹丸）会产生上千个 GPU 对象并立刻销毁。
       下面按固定上限预分配并循环复用，运行期不再分配 GPU 资源。 */
    this._tracerPool = [];
    this._tracerFree = [];
    this._sparkPool = [];
    this._sparkFree = [];
    /* 复用的矩阵/向量：impact() 原先每次调用新建 Matrix4+Quaternion+2×Vector3 */
    this._m4 = new THREE.Matrix4();
    this._q0 = new THREE.Quaternion();
    this._v3 = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    const TRACER_MAX = 96, SPARK_MAX = 160;
    for (let i = 0; i < TRACER_MAX; i++) {
      /* 每条曳光弹必须有自己的 geometry（端点各不相同），
         但都在构造期一次性分配；运行期只改写顶点，不再新建。 */
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
      /* 同理：每个火花需要独立材质，否则同色火花的 opacity 会互相覆盖 */
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
    // 池耗尽就丢弃这条曳光弹（纯视觉，寿命 55ms，不会造成信息缺失）
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
        slot.m.visible = false;              // 归还池中，不销毁、不重新分配
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
      /* 用 dt 归一化衰减：原来的「每帧 *0.55」在 144Hz 下衰减速度是 60Hz 的 2.4 倍，
         枪口闪光在不同刷新率下亮度/持续感不一致。 */
      if (this.muzzleTimer <= 0) this.muzzleLight.intensity = 0;
      else this.muzzleLight.intensity *= Math.exp(-dt * 35.8);   // 等效 60fps 下的 0.55
    }
  }

  /** 烟幕是否遮挡两点之间的视线 */
  smokeBlocks(ax, ay, az, bx, by, bz) {
    for (const c of this.smoke) {
      if (c.life < 2) continue;
      const r = c.r * c.group.scale.x;
      // 点到线段距离（XZ 平面）+ 高度判断
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

/* ---------------- 投掷物 ---------------- */
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
      // 简易碰撞
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
      /* 关键顺序：先标记 + 先出列，再引爆。
         否则一旦 detonate 抛异常，带 fuse<=0 的弹体会留在数组里，
         下一帧再次引爆 —— 每帧重复创建音频节点，直接卡死主线程。 */
      p.detonated = true;
      game.projectiles.splice(i, 1);
      try {
        detonate(game, p);
      } catch (err) {
        console.error('[SILENT MERIDIAN] 投掷物引爆失败（已出列，不会重复触发）', err);
      }
      if (p.mesh) {
        /* 投掷物 mesh 是每次投掷新建的（player.throwGadget），
           只 remove 不 dispose 会持续泄漏 GPU 资源。 */
        game.scene.remove(p.mesh);
        if (p.mesh.geometry) p.mesh.geometry.dispose();
        if (p.mesh.material) p.mesh.material.dispose();
        p.mesh = null;
      }
    }
  }
}

/** 兜底：清理所有已引爆或超时残留的弹体（正常情况下数组应为空） */
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
    game.log('烟幕展开 — 视线阻断', 'warn');
    game.addMapEvent(p.x, p.z, '烟幕展开', 'support');
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
    game.addMapEvent(p.x, p.z, '爆炸', 'explosion');
    game.raiseAlarm('爆炸声');
    return;
  }
  // 闪光弹
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
      // 白屏必须“即刻”出现（此前错误地在失能结束时才闪），且只改 opacity
      if (game.ui) game.ui.flash(0.30 + 0.55 * k);
    }
  }
  game.log('闪光弹引爆 — 目标失能', 'good');
  game.addMapEvent(p.x, p.z, '闪光弹', 'explosion');
  game.raiseAlarm('闪光弹');
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
