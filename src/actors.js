/* ============================================================
   actors.js — 人物模型、小队 AI、嫌疑人 AI、平民 AI
   ============================================================ */
import * as THREE from 'three';
import { clamp, angleDamp, shortAngle, moveCircle, dist2D, makeRng, TAU } from './geom.js';
import { castRay, sameTeam } from './combat.js';
import { feel } from './feel.js';

/* 群体分离用的复用坐标缓冲（见 Actor.moveDir） */
const _sepPos = { x: 0, z: 0 };

const rng = makeRng(4242);

/* ============================================================
   共享材质
   ============================================================ */
export const MAT = {
  squadUniform: new THREE.MeshStandardMaterial({ color: 0x36506e, emissive: 0x0c141d, emissiveIntensity: 1, roughness: 0.85, metalness: 0.06 }),
  squadVest:    new THREE.MeshStandardMaterial({ color: 0x222f40, emissive: 0x090e14, emissiveIntensity: 1, roughness: 0.7, metalness: 0.12 }),
  squadHelmet:  new THREE.MeshStandardMaterial({ color: 0x2a3c50, emissive: 0x0a1119, emissiveIntensity: 1, roughness: 0.55, metalness: 0.25 }),
  reflect:      new THREE.MeshStandardMaterial({ color: 0x8fe8ff, emissive: 0x2f7f96, emissiveIntensity: 0.85, roughness: 0.4 }),
  suspectCloth: new THREE.MeshStandardMaterial({ color: 0x53483c, emissive: 0x100d09, emissiveIntensity: 1, roughness: 0.92, metalness: 0.03 }),
  suspectDark:  new THREE.MeshStandardMaterial({ color: 0x2a2621, emissive: 0x0a0908, emissiveIntensity: 1, roughness: 0.9, metalness: 0.04 }),
  civCloth:     new THREE.MeshStandardMaterial({ color: 0x54666f, emissive: 0x0c1114, emissiveIntensity: 1, roughness: 0.9, metalness: 0.03 }),
  hiVis:        new THREE.MeshStandardMaterial({ color: 0xd7a63c, emissive: 0x3a2a08, emissiveIntensity: 0.5, roughness: 0.75 }),
  skin:         new THREE.MeshStandardMaterial({ color: 0x8a6a55, roughness: 0.85, metalness: 0.02 }),
  gun:          new THREE.MeshStandardMaterial({ color: 0x181c20, roughness: 0.42, metalness: 0.72 }),
  gunWood:      new THREE.MeshStandardMaterial({ color: 0x3d3021, roughness: 0.7, metalness: 0.1 }),
  boot:         new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 0.8, metalness: 0.1 }),
};

function mkBox(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}
function mkCyl(r, h, mat, seg = 8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.castShadow = true;
  return m;
}

/* 步枪 / 手枪模型 */
function buildRifle(scale = 1) {
  const g = new THREE.Group();
  const body = mkBox(0.075, 0.11, 0.62 * scale, MAT.gun); g.add(body);
  const barrel = mkCyl(0.021, 0.42 * scale, MAT.gun); barrel.rotation.x = Math.PI / 2; barrel.position.z = -0.48 * scale; g.add(barrel);
  const mag = mkBox(0.05, 0.20, 0.10, MAT.gun); mag.position.set(0, -0.14, 0.02); mag.rotation.x = 0.18; g.add(mag);
  const stock = mkBox(0.055, 0.09, 0.24, MAT.gunWood); stock.position.z = 0.36 * scale; g.add(stock);
  const grip = mkBox(0.05, 0.13, 0.06, MAT.gun); grip.position.set(0, -0.11, 0.14); grip.rotation.x = -0.25; g.add(grip);
  const rail = mkBox(0.05, 0.035, 0.16, MAT.gun); rail.position.set(0, 0.075, -0.06); g.add(rail);
  const dot = mkBox(0.02, 0.02, 0.02, MAT.reflect); dot.position.set(0, 0.10, -0.06); g.add(dot);
  return g;
}
function buildSidearm() {
  const g = new THREE.Group();
  const slide = mkBox(0.045, 0.075, 0.24, MAT.gun); g.add(slide);
  const grip = mkBox(0.045, 0.13, 0.055, MAT.gun); grip.position.set(0, -0.09, 0.07); grip.rotation.x = -0.22; g.add(grip);
  return g;
}

/* ============================================================
   人体模型
   ============================================================ */
export function buildHuman(opts) {
  const kind = opts.kind;         // 'squad' | 'suspect' | 'civilian' | 'player'
  const group = new THREE.Group();
  const parts = {};

  const isSquad = kind === 'squad' || kind === 'player';
  const cloth = isSquad ? MAT.squadUniform : (kind === 'suspect' ? MAT.suspectCloth : MAT.civCloth);
  const vest = isSquad ? MAT.squadVest : null;
  const scale = opts.scale || 1;

  // 腿
  const hips = [-0.13, 0.13];
  parts.legs = [];
  hips.forEach((hx, i) => {
    const hip = new THREE.Group();
    hip.position.set(hx, 0.92, 0);
    const thigh = mkBox(0.175, 0.92, 0.20, cloth); thigh.position.y = -0.46; hip.add(thigh);
    const boot = mkBox(0.19, 0.12, 0.27, MAT.boot); boot.position.set(0, -0.87, 0.03); hip.add(boot);
    group.add(hip);
    parts.legs.push(hip);
  });

  // 躯干
  const torso = new THREE.Group();
  torso.position.y = 0.92;
  const chest = mkBox(0.52 * scale, 0.62, 0.30 * scale, cloth);
  chest.position.y = 0.31; torso.add(chest);
  const belt = mkBox(0.50 * scale, 0.10, 0.28 * scale, isSquad ? MAT.squadVest : MAT.suspectDark);
  belt.position.y = 0.02; torso.add(belt);
  if (isSquad) {
    const v = mkBox(0.56 * scale, 0.44, 0.36 * scale, vest); v.position.y = 0.32; torso.add(v);
    for (const bx of [-0.14, 0.14]) {
      const band = mkBox(0.10, 0.05, 0.335 * scale, MAT.reflect); band.position.set(bx, 0.50, 0); torso.add(band);
    }
    const backBand = mkBox(0.30, 0.06, 0.06, MAT.reflect); backBand.position.set(0, 0.46, 0.20 * scale); torso.add(backBand);
    const pouch = mkBox(0.12, 0.14, 0.10, MAT.squadVest); pouch.position.set(-0.20, 0.16, -0.19); torso.add(pouch);
  } else if (kind === 'suspect') {
    const chestRig = mkBox(0.42, 0.34, 0.36, MAT.suspectDark); chestRig.position.y = 0.33; torso.add(chestRig);
    const pouch = mkBox(0.14, 0.16, 0.12, MAT.suspectDark); pouch.position.set(0.16, 0.10, -0.18); torso.add(pouch);
  } else {
    const hi = mkBox(0.54, 0.40, 0.33, MAT.hiVis); hi.position.y = 0.30; torso.add(hi);
    for (const by of [0.16, 0.46]) {
      const band = mkBox(0.55, 0.045, 0.345, MAT.reflect); band.position.y = by; torso.add(band);
    }
  }
  group.add(torso);
  parts.torso = torso;

  // 头 / 头盔 / 头套
  const head = new THREE.Group();
  head.position.y = 1.60;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), MAT.skin);
  skull.castShadow = true; head.add(skull);
  if (isSquad) {
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 8, 0, TAU, 0, Math.PI * 0.62), MAT.squadHelmet);
    helmet.position.y = 0.015; helmet.castShadow = true; head.add(helmet);
    const brim = mkBox(0.26, 0.03, 0.10, MAT.squadHelmet); brim.position.set(0, 0.02, -0.14); head.add(brim);
    const light = mkBox(0.035, 0.03, 0.02, MAT.reflect); light.position.set(0.09, 0.05, -0.10); head.add(light);
  } else if (kind === 'suspect') {
    const bal = new THREE.Mesh(new THREE.SphereGeometry(0.128, 12, 8, 0, TAU, 0, Math.PI * 0.72), MAT.suspectDark);
    bal.position.y = 0.005; head.add(bal);
    const hood = mkBox(0.30, 0.22, 0.30, MAT.suspectCloth); hood.position.y = -0.02; head.add(hood);
  } else {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.132, 10, 6, 0, TAU, 0, Math.PI * 0.5), MAT.hiVis);
    cap.position.y = 0.03; head.add(cap);
  }
  group.add(head);
  parts.head = head;

  // 手臂
  parts.arms = [];
  [-1, 1].forEach((sgn, i) => {
    const sh = new THREE.Group();
    sh.position.set(sgn * 0.32 * scale, 1.44, 0);
    const upper = mkBox(0.135, 0.34, 0.15, cloth); upper.position.y = -0.17; sh.add(upper);
    const lower = mkBox(0.12, 0.30, 0.13, isSquad ? cloth : MAT.skin); lower.position.y = -0.48; sh.add(lower);
    group.add(sh);
    parts.arms.push(sh);
  });

  // 武器
  if (kind !== 'civilian') {
    const w = kind === 'suspect' && rng.next() < 0.35 ? buildSidearm() : buildRifle(1);
    if (kind === 'suspect' && w.children.length === 3) w.scale.setScalar(0.9);
    w.position.set(0.16, 1.33, -0.26);
    w.rotation.set(0, 0, -0.08);
    group.add(w);
    parts.weapon = w;
  }
  if (kind === 'civilian') {
    const bag = mkBox(0.26, 0.30, 0.14, MAT.suspectDark); bag.position.set(0.0, 1.10, 0.20); group.add(bag);
  }

  // 接地阴影
  const blobC = document.createElement('canvas');
  blobC.width = blobC.height = 64;
  const bg = blobC.getContext('2d');
  const rg = bg.createRadialGradient(32, 32, 2, 32, 32, 30);
  rg.addColorStop(0, 'rgba(0,0,0,.55)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  bg.fillStyle = rg; bg.fillRect(0, 0, 64, 64);
  const blobTex = new THREE.CanvasTexture(blobC);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  group.add(blob);
  parts.blob = blob;

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group, parts };
}

/* ============================================================
   单位标记（准星上方图标）
   ============================================================ */
function markerTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const col = kind === 'squad' ? '#7fe0ff' : kind === 'suspect' ? '#ff7a63'
    : kind === 'civilian' ? '#8ee08a' : '#b9c4cc';
  g.strokeStyle = col; g.lineWidth = 7; g.lineJoin = 'round';
  g.beginPath();
  if (kind === 'squad' || kind === 'civilian') {
    g.moveTo(24, 74); g.lineTo(64, 38); g.lineTo(104, 74);
  } else if (kind === 'suspect') {
    g.moveTo(24, 54); g.lineTo(64, 90); g.lineTo(104, 54);
  } else {
    g.arc(64, 64, 26, 0, TAU);
    g.moveTo(64, 18); g.lineTo(64, 40);
  }
  g.stroke();
  if (kind === 'unknown') {
    g.fillStyle = col; g.font = 'bold 52px monospace'; g.fillText('?', 50, 60);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const MARKER_TEX = {
  squad: markerTexture('squad'),
  suspect: markerTexture('suspect'),
  civilian: markerTexture('civilian'),
  unknown: markerTexture('unknown'),
};

/* ============================================================
   基础角色
   ============================================================ */
let ACTOR_ID = 0;

export class Actor {
  constructor(game, cfg) {
    this.game = game;
    this.id = ++ACTOR_ID;
    this.kind = cfg.kind;
    this.name = cfg.name || 'UNIT';
    this.callsign = cfg.callsign || this.name;
    this.pos = { x: cfg.x, z: cfg.z };
    this.y = 0;
    this.yaw = cfg.yaw || 0;
    this.targetYaw = this.yaw;
    this.radius = 0.42;
    this.height = 1.8;
    this.maxHp = cfg.hp || 100;
    this.hp = this.maxHp;
    this.alive = true;
    this.state = 'idle';
    this.speed = cfg.speed || 1.6;
    this.vel = 0;
    this.path = null; this.pathIdx = 0; this.pathAge = 0;
    /* 识别度：友军天然是「已识别」，否则面向队友会显示成 UNKNOWN CONTACT */
    const isFriendly = (this.kind === 'squad' || this.kind === 'player');
    this.ident = isFriendly ? 1 : 0;   // 玩家识别度 0..1
    this.seen = isFriendly;            // 玩家是否曾看见
    this.identified = isFriendly;
    this.blind = 0;
    this.suppression = 0;
    this.morale = 1;
    this.crouch = false;
    this.phase = Math.random() * 10;
    this.aimTarget = null;
    this.fireCd = 0;
    this.burst = 0;
    this.weaponDamage = cfg.damage || 14;
    this.hostile = cfg.hostile !== false && (this.kind === 'suspect');
    this.lethal = cfg.lethal !== false;
    this.marker = null;
    this.cuffed = false;

    const built = buildHuman({ kind: this.kind, scale: cfg.scale || 1 });
    this.group = built.group;
    this.parts = built.parts;
    this.group.position.set(this.pos.x, 0, this.pos.z);
    this.group.rotation.y = this.yaw;
    this.group.visible = this.kind !== 'player';
    game.scene.add(this.group);

    if (this.kind !== 'player') {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: MARKER_TEX[this.kind], transparent: true, depthTest: false, depthWrite: false, opacity: 0.9,
      }));
      sp.scale.set(0.55, 0.55, 1);
      sp.renderOrder = 30;
      sp.visible = this.kind === 'squad';
      sp.position.set(0, 2.15, 0);
      this.group.add(sp);
      this.marker = sp;
    }
  }

  get eye() { return { x: this.pos.x, y: this.y + (this.crouch ? 1.15 : 1.62), z: this.pos.z }; }
  get dist() { return dist2D(this.pos.x, this.pos.z, this.game.player.pos.x, this.game.player.pos.z); }

  /* -------- 视觉 -------- */
  animate(dt) {
    const p = this.parts;
    const spd = Math.min(this.vel, 5);
    const amp = clamp(spd / 2.4, 0, 1.2);
    this.phase += dt * (2.0 + spd * 2.4);
    const s = Math.sin(this.phase);
    if (p.legs) {
      p.legs[0].rotation.x = s * 0.55 * amp;
      p.legs[1].rotation.x = -s * 0.55 * amp;
    }
    if (p.arms) {
      const aim = this.aimTarget ? 1 : 0;
      const aBase = this.kind === 'civilian' ? 0.1 : -0.35 * aim;
      p.arms[0].rotation.x = -s * 0.45 * amp - aBase;
      p.arms[1].rotation.x = s * 0.45 * amp - aBase;
      p.arms[0].rotation.z = 0.06;
      p.arms[1].rotation.z = -0.06;
    }
    if (p.torso) p.torso.position.y = 0.92 + Math.abs(Math.cos(this.phase)) * 0.02 * amp;
    if (this.crouch) {
      if (!this._crouched) { this.group.scale.y = 0.78; this._crouched = true; }
    } else if (this._crouched) { this.group.scale.y = 1; this._crouched = false; }
    if (this.blind > 0 && p.head) {
      p.head.rotation.z = Math.sin(this.phase * 4) * 0.25;
      p.head.rotation.x = 0.3;
    } else if (p.head) {
      /* dt 归一化回正：原来的「每帧 *0.95」在 144Hz 下回正速度快 2.4 倍，
         受击甩头/致盲低头的恢复速度会随刷新率变化。 */
      const k = Math.exp(-dt * 3.08);   // 等效 60fps 下的 0.95
      p.head.rotation.x *= k;
      p.head.rotation.z *= k;
    }
  }

  syncTransform() {
    const g = this.group;
    g.position.set(this.pos.x, this.y, this.pos.z);
    g.rotation.y = this.yaw;
    if (this.marker) {
      if (this.kind === 'squad') {
        this.marker.visible = this.alive;
        this.marker.material.opacity = 0.55 + 0.25 * Math.sin(performance.now() * 0.002 + this.id);
      } else if (this.identified && this.alive) {
        this.marker.visible = true;
        this.marker.material.opacity = 0.5;
      } else if (this.seen && !this.identified && this.alive) {
        if (this.marker.material.map !== MARKER_TEX.unknown) {
          this.marker.material.map = MARKER_TEX.unknown;
          this.marker.material.needsUpdate = true;
        }
        this.marker.visible = true;
        this.marker.material.opacity = 0.34;
      } else {
        this.marker.visible = false;
      }
    }
  }

  /* -------- 移动 -------- */
  moveDir(fx, fz, speed, dt) {
    const len = Math.hypot(fx, fz) || 1;
    const m = speed * dt;
    /* 用位移向量的模长算速度。
       这里曾经写的是 Math.abs(this.pos.x + this.pos.z - before) —— 坐标「和」的变化量，
       对 dx = -dz 的斜向移动恒等于 0（yaw=0 时按 W+D 全速前进，vel 却读数为 0），
       导致走路动画冻结、移动扩散惩罚失效、警觉与识别加成不触发。 */
    const x0 = this.pos.x, z0 = this.pos.z;
    moveCircle(this.game.world.grid, this.pos, this.radius, (fx / len) * m, (fz / len) * m,
      this.y, this.height);
    this.vel = Math.hypot(this.pos.x - x0, this.pos.z - z0) / Math.max(dt, 1e-4);
    // 分离（复用同一个坐标缓冲，避免每次推挤都新建对象）
    const q = _sepPos;
    for (const o of this.game.actors) {
      if (o === this || !o.alive) continue;
      const d = dist2D(this.pos.x, this.pos.z, o.pos.x, o.pos.z);
      const min = this.radius + o.radius + 0.1;
      if (d < min && d > 1e-4) {
        const push = (min - d) * 0.5;
        const nx = (this.pos.x - o.pos.x) / d, nz = (this.pos.z - o.pos.z) / d;
        q.x = this.pos.x; q.z = this.pos.z;
        moveCircle(this.game.world.grid, q, this.radius, nx * push, nz * push, this.y, this.height);
        this.pos.x = q.x; this.pos.z = q.z;
      }
    }
    this.targetYaw = Math.atan2(-(fx / len), -(fz / len));
  }

  setPath(tx, tz) {
    const nav = this.game.nav;
    const p = nav.findPath(this.pos.x, this.pos.z, tx, tz);
    this.path = p;
    this.pathIdx = 0;
    this.pathAge = 0;
    return !!p;
  }

  /** 沿路径前进；返回是否已到达终点 */
  followPath(dt, speed) {
    if (!this.path || this.pathIdx >= this.path.length) { this.vel = 0; return true; }
    const wp = this.path[this.pathIdx];
    const d = dist2D(this.pos.x, this.pos.z, wp.x, wp.z);
    if (d < 1.0) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) { this.vel = 0; return true; }
      return false;
    }
    this.moveDir((wp.x - this.pos.x) / d, (wp.z - this.pos.z) / d, speed, dt);
    return false;
  }

  stop() { this.path = null; this.vel = 0; }

  /* -------- 感知 -------- */
  canSee(target, maxDist, fovCos) {
    const eye = this.eye;
    const tgt = target.eye || { x: target.pos.x, y: target.y + 1.2, z: target.pos.z };
    const dx = tgt.x - eye.x, dz = tgt.z - eye.z;
    const d = Math.hypot(dx, dz);
    if (d > maxDist) return false;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const dot = (dx * fx + dz * fz) / (d || 1);
    if (fovCos !== undefined && dot < fovCos && d > 3.5) return false;
    if (this.game.effects.smokeBlocks(eye.x, eye.y, eye.z, tgt.x, tgt.y, tgt.z)) return false;
    return !this.game.losBlocked(eye.x, eye.y, eye.z, tgt.x, tgt.y, tgt.z);
  }

  /* -------- 战斗 -------- */
  suppress(amount, level = 1) {
    this.suppression = Math.min(3, this.suppression + amount);
    if (this.kind === 'suspect') this.morale = Math.max(0, this.morale - 0.035 * amount * level);
    if (this.kind === 'civilian' && amount > 1) this.panic();
  }

  takeDamage(dmg, from, point) {
    if (!this.alive) return;
    // 兜底：即使有其它伤害入口（爆炸、脚本），同阵营也绝不吃伤害
    if (from && from !== this && sameTeam(from, this)) return;
    if (feel.debug.invincible && this.kind === 'player') return;   // 调参用无敌
    this.hp -= dmg;
    this.suppress(0.9, 1);
    this.lastHitFrom = from;
    if (this.kind === 'suspect') {
      this.morale = Math.max(0, this.morale - 0.05);
      if (!this.alerted) this.alerted = true;
      this.game.onSuspectAlerted(this, point);
    }
    if (this.hp <= 0) this.goDown();
    else if (this.kind === 'squad' || this.kind === 'player') {
      this.game.onSquadHurt && this.game.onSquadHurt(this);
    }
  }

  goDown() {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    this.state = 'down';
    this.vel = 0;
    this.group.rotation.x = -Math.PI / 2.1;
    this.group.position.y = 0.28;
    this.dead = true;
    if (this.kind === 'squad' || this.kind === 'player') this.game.onSquadDown(this);
    else if (this.kind === 'suspect') this.game.onSuspectDown(this);
    else if (this.kind === 'civilian') this.game.onCivilianDown(this);
    if (this.marker) this.marker.visible = false;
  }

  revivable() { return !this.alive && this.kind === 'squad' && !this.bledOut; }

  revive() {
    if (!this.revivable()) return;
    this.alive = true;
    this.hp = this.maxHp * 0.45;
    this.blind = 0;
    this.state = 'follow';
    this.group.rotation.x = 0;
    this.group.position.y = 0;
    if (this.marker) this.marker.visible = true;
    this.game.log(`${this.callsign} 恢复行动能力`, 'good');
  }

  /* -------- 射击目标选择 -------- */
  pickTarget(maxDist, preferred) {
    const g = this.game;
    let best = null, bestScore = -Infinity;
    for (const a of g.actors) {
      if (a === this || !a.alive) continue;
      if (this.kind === 'suspect' && a.kind !== 'squad' && a.kind !== 'player' && a.kind !== 'civilian') continue;
      if (this.kind === 'suspect' && a.kind === 'civilian' && !this.attackCivilians) continue;
      if ((this.kind === 'squad' || this.kind === 'player') && a.kind !== 'suspect') continue;
      if (a.surrendered && this.kind === 'squad') continue;
      if (!this.canSee(a, maxDist, this.kind === 'suspect' ? Math.cos(1.25) : undefined)) continue;
      const d = dist2D(this.pos.x, this.pos.z, a.pos.x, a.pos.z);
      let score = 100 - d;
      if (a.kind === 'civilian') score -= 60;
      if (preferred && a.kind === preferred) score += 25;
      if (a === g.player) score += 6;
      if (d < 8) score += 18;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  shootAt(target, spreadBase, burstLen, tracerColor = 0xffdca6) {
    const g = this.game;
    const eye = this.eye;
    const tgt = { x: target.pos.x, y: target.y + (target.crouch ? 0.85 : 1.15), z: target.pos.z };
    let dx = tgt.x - eye.x, dy = tgt.y - eye.y, dz = tgt.z - eye.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    dx /= dist; dy /= dist; dz /= dist;
    const spread = spreadBase * (1 + this.suppression * 0.5 + (this.vel > 0.4 ? 1.2 : 0));
    const a = Math.random() * TAU, r = Math.random() * spread;
    // 在垂直于视线方向上加偏移
    const upx = 0, upy = 1, upz = 0;
    let rx = dy * upz - dz * upy, ry = dz * upx - dx * upz, rz = dx * upy - dy * upx;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    let ux = ry * dz - rz * dy, uy = rz * dx - rx * dz, uz = rx * dy - ry * dx;
    const ox = Math.cos(a) * r, oy = Math.sin(a) * r;
    dx += rx * ox + ux * oy; dy += ry * ox + uy * oy; dz += rz * ox + uz * oy;
    const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;

    const hit = castRay(g, eye.x, eye.y, eye.z, dx, dy, dz, 130, this);
    const end = hit.wall || hit.miss ? hit.point : { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    if (this.kind === 'squad' || this.kind === 'player') {
      const origin = {
        x: eye.x + dx * 0.5 + (this.kind === 'player' ? 0 : 0.15),
        y: eye.y - 0.12, z: eye.z + dz * 0.5,
      };
      g.effects.tracer(origin, end, tracerColor);
    }
    if (hit.actor) {
      hit.actor.takeDamage(this.weaponDamage, this, hit.point);
      g.effects.impact(hit.point, 0xff9a72, 0.9);
      if (this.kind === 'player') g.onPlayerHit(hit.actor, hit.point);
    } else if (hit.wall) {
      g.effects.impact(hit.point, 0xffd7a0, 0.7);
    }
    g.onShotFired(this, hit);
    return hit;
  }

  updateCommon(dt) {
    if (this.blind > 0) {
      this.blind -= dt;
    }
    if (this.suppression > 0) this.suppression = Math.max(0, this.suppression - dt * 0.75);
    if (this.fireCd > 0) this.fireCd -= dt;
  }
}

/* ============================================================
   小队成员
   ============================================================ */
const FORMATION = [
  { r: -2.3, b: 2.0 },
  { r: 2.3, b: 2.0 },
  { r: -4.6, b: 3.8 },
  { r: 4.6, b: 3.8 },
];
const REGROUP_FORMATION = [
  { r: -1.5, b: 1.4 },
  { r: 1.5, b: 1.4 },
  { r: -3.0, b: 2.6 },
  { r: 3.0, b: 2.6 },
];

export class SquadMember extends Actor {
  constructor(game, cfg, slot) {
    super(game, {
      kind: 'squad', name: cfg.name, callsign: cfg.callsign,
      x: cfg.x, z: cfg.z, yaw: cfg.yaw, hp: 130, speed: 2.35,
    });
    this.slot = slot;
    this.tag = cfg.tag || 'RIFLEMAN';
    this.state = 'follow';
    this.faceYaw = this.yaw;
    this.reportCd = 0;
    this.weaponDamage = 16;
    this.element = slot % 2;
    this.holdAt = null;
    this.lastOrder = 'follow';
  }

  slotPos(formation) {
    const lead = this.game.player;
    const yaw = lead.yaw;
    const f = formation[this.slot];
    return {
      x: lead.pos.x + f.r * Math.cos(yaw) + f.b * Math.sin(yaw),
      z: lead.pos.z - f.r * Math.sin(yaw) + f.b * Math.cos(yaw),
    };
  }

  update(dt) {
    if (!this.alive) return;
    this.updateCommon(dt);
    const g = this.game;
    const order = g.squadOrder;
    if (this.reportCd > 0) this.reportCd -= dt;

    // 目标选择
    const target = this.pickTarget(58, 'suspect');
    const engaged = !!target && g.weaponsFree;
    this.aimTarget = (target && g.weaponsFree) ? target : null;

    if (this.blind > 0) {
      this.vel = 0;
      this.crouch = true;
      this.animate(dt); this.syncTransform();
      return;
    }
    this.crouch = false;

    switch (order) {
      case 'hold': {
        if (!this.holdAt) this.holdAt = { x: this.pos.x, z: this.pos.z };
        this.vel = 0;
        this.targetYaw = target ? Math.atan2(-(target.pos.x - this.pos.x), -(target.pos.z - this.pos.z)) : this.faceYaw;
        break;
      }
      case 'clear': {
        const wp = g.squadWaypoint;
        const active = g.boundPhase === this.element;
        if (wp && active) {
          if ((this.pathAge += dt) > 2.2 || !this.path) { this.setPath(wp.x, wp.z); this.pathAge = 0; }
          const done = this.followPath(dt, this.speed * 0.92);
          if (done) { g.onElementArrived(this); }
          this.targetYaw = this.aimTarget
            ? Math.atan2(-(this.aimTarget.pos.x - this.pos.x), -(this.aimTarget.pos.z - this.pos.z))
            : this.targetYaw;
        } else {
          this.vel = 0;
          const fwd = wp ? Math.atan2(-(wp.x - this.pos.x), -(wp.z - this.pos.z)) : this.yaw;
          this.targetYaw = this.aimTarget
            ? Math.atan2(-(this.aimTarget.pos.x - this.pos.x), -(this.aimTarget.pos.z - this.pos.z))
            : fwd;
        }
        break;
      }
      case 'regroup':
      case 'follow':
      default: {
        const sp = this.slotPos(order === 'regroup' ? REGROUP_FORMATION : FORMATION);
        const d = dist2D(this.pos.x, this.pos.z, sp.x, sp.z);
        if (d > 1.1) {
          if ((this.pathAge += dt) > 1.4 || !this.path) { this.setPath(sp.x, sp.z); this.pathAge = 0; }
          this.followPath(dt, this.speed * (d > 14 ? 1.35 : d > 6 ? 1.12 : 0.9));
        } else {
          this.vel = 0; this.path = null;
          this.targetYaw = this.aimTarget
            ? Math.atan2(-(this.aimTarget.pos.x - this.pos.x), -(this.aimTarget.pos.z - this.pos.z))
            : g.player.yaw;
        }
        break;
      }
    }

    // 报告与开火
    if (target) {
      this.report(target);
      if (engaged && this.fireCd <= 0) {
        const d = dist2D(this.pos.x, this.pos.z, target.pos.x, target.pos.z);
        const spread = 0.020 + d * 0.0016;
        this.shootAt(target, spread, 3, 0xbfe6ff);
        this.fireCd = 0.12;
        this.burst++;
        if (this.burst >= 3) { this.burst = 0; this.fireCd = 0.55 + Math.random() * 0.5; }
      }
    } else {
      this.burst = 0;
    }

    if (g.squadOrder !== this.lastOrder) {
      this.lastOrder = g.squadOrder;
      this.holdAt = g.squadOrder === 'hold' ? { x: this.pos.x, z: this.pos.z } : null;
    }

    this.yaw = angleDamp(this.yaw, this.targetYaw, 6, dt);
    this.animate(dt);
    this.syncTransform();
  }

  report(target) {
    if (this.reportCd > 0) return;
    if (this.kind !== 'squad') return;
    const g = this.game;
    if (!target.seen) {
      /* 小队先于玩家发现接触：标记为「已知但未识别」并呼叫。
         此前这里直接 `return`，导致下面那一支永远不可达 ——
         小队永远不可能先敌发现，LINES.squadSpotUnknown 成了死数据。
         注意 seen 只影响「未识别接触（?）」标记是否出现（README 的核心机制之一），
         识别（identified / ident）仍然要由玩家或共享识别流程推进。 */
      target.seen = true;
      g.squadReport('squadSpotUnknown', this, target);
      g.addMapEvent(target.pos.x, target.pos.z, '小队报告：有动静', 'sighting');
      this.reportCd = 2.5;
      return;
    }
    if (target.ident >= 0.8 && !target.identified) {
      target.identified = true;
      if (target.kind === 'suspect') {
        g.squadReport('squadIdArmed', this, target);
      } else {
        g.squadReport('squadIdCiv', this, target);
      }
      this.reportCd = 3.5;
    }
  }
}

/* ============================================================
   嫌疑人
   ============================================================ */
export class Suspect extends Actor {
  constructor(game, cfg) {
    super(game, {
      kind: 'suspect', name: cfg.name, x: cfg.x, z: cfg.z, yaw: cfg.yaw || 0,
      hp: cfg.elite ? 130 : 100, speed: cfg.speed || 2.0,
    });
    this.patrolRoute = cfg.patrol || null;
    this.patrolIdx = 0;
    this.post = cfg.post || null;
    this.pauseT = 0;
    this.awareness = 0;
    this.alerted = false;
    this.surrendered = false;
    this.detained = false;
    this.elite = !!cfg.elite;
    this.weaponDamage = cfg.elite ? 17 : 14;
    this.fireCd = 1 + Math.random() * 1.5;
    /* 首个点射就是完整的 3~5 发；burstGap 必须为正，否则第一轮点射后会立刻续射 */
    this.burstLeft = 3 + Math.floor(Math.random() * 3);
    this.burstGap = 0.55 + Math.random() * 0.5;
    this.coverPos = null;
    this.scanPhase = Math.random() * TAU;
    this.lookTimer = 0;
    this.target = null;
    this.callCd = 0;
    this.wander = { x: cfg.x, z: cfg.z };
    this.state = cfg.patrol ? 'patrol' : 'post';
    this.aggression = 0.5 + Math.random() * 0.5;
  }

  update(dt) {
    if (!this.alive) return;
    this.updateCommon(dt);
    const g = this.game;
    if (this.callCd > 0) this.callCd -= dt;

    if (this.detained) {
      this.vel = 0; this.crouch = true;
      this.animate(dt); this.syncTransform();
      return;
    }
    if (this.surrendered) {
      this.vel = 0; this.crouch = false;
      this.targetYaw = g.player ? Math.atan2(-(g.player.pos.x - this.pos.x), -(g.player.pos.z - this.pos.z)) : this.yaw;
      this.yaw = angleDamp(this.yaw, this.targetYaw, 3, dt);
      if (this.parts.arms) { this.parts.arms[0].rotation.x = -2.6; this.parts.arms[1].rotation.x = -2.6; }
      if (this.parts.weapon) this.parts.weapon.visible = false;
      this.animate(dt); this.syncTransform();
      return;
    }
    if (this.blind > 0) {
      this.vel = 0;
      this.crouch = true;
      this.awareness = Math.max(0, this.awareness - dt * 0.5);
      this.animate(dt); this.syncTransform();
      return;
    }

    // 感知
    const seen = this.perceive(dt);
    this.morale = Math.min(1, this.morale + dt * 0.02);
    if (this.morale < 0.32 && this.hp < this.maxHp * 0.7 && !this.detained) {
      const chance = (0.32 - this.morale) * dt * 1.6;
      if (Math.random() < chance) this.surrender();
    }

    switch (this.state) {
      case 'post':
      case 'patrol': this.doPatrol(dt); break;
      case 'alert': case 'engage': this.doEngage(dt, seen); break;
      default: this.doPatrol(dt);
    }

    this.crouch = (this.state === 'engage' && this.coverPos) ? true : false;
    this.yaw = angleDamp(this.yaw, this.targetYaw, this.state === 'engage' ? 7 : 3.2, dt);
    this.animate(dt);
    this.syncTransform();
  }

  perceive(dt) {
    const g = this.game;
    let best = null, bestD = Infinity;
    for (const a of g.actors) {
      if (!a.alive) continue;
      if (a.kind === 'suspect') continue;
      if (a.kind === 'civilian' && !this.attackCivilians) continue;
      const d = dist2D(this.pos.x, this.pos.z, a.pos.x, a.pos.z);
      if (!this.canSee(a, 44, Math.cos(1.3))) continue;
      if (d < bestD) { bestD = d; best = a; }
    }
    if (best) {
      this.seenTarget = best;
      let rate = (bestD < 10 ? 3.2 : bestD < 22 ? 2.0 : 1.1) * dt;
      if (g.lightOn && bestD < 46) rate *= 1.55;   // 战术灯暴露位置
      if (best.kind === 'squad' && best.vel > 1.6) rate *= 1.25;
      this.awareness += rate;
      if (this.awareness >= 1 && !this.alerted) {
        this.alerted = true;
        this.target = best;
        this.state = 'engage';
        g.onSuspectAlerted(this, { x: this.pos.x, y: 1.5, z: this.pos.z });
        if (this.callCd <= 0) {
          g.enemyCall(this);
          this.callCd = 6;
        }
      }
      if (this.awareness >= 1) this.target = best;
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.35);
    }
    if (this.alerted) {
      // 保持对最近威胁的追踪
      if (!this.target || !this.target.alive) this.target = this.seenTarget || this.target;
    }
    return this.awareness >= 1;
  }

  doPatrol(dt) {
    if (this.pauseT > 0) {
      this.pauseT -= dt;
      this.vel = 0;
      this.scanPhase += dt * 1.1;
      this.targetYaw = this.baseYaw + Math.sin(this.scanPhase) * 0.55;
      return;
    }
    const route = this.patrolRoute;
    if (!route) {
      // 站岗：缓慢环视
      this.vel = 0;
      this.scanPhase += dt * 0.55;
      if (this.baseYaw === undefined) this.baseYaw = this.yaw;
      this.targetYaw = this.baseYaw + Math.sin(this.scanPhase) * 0.75;
      return;
    }
    const wp = route[this.patrolIdx % route.length];
    const d = dist2D(this.pos.x, this.pos.z, wp[0], wp[1]);
    if (d < 1.3) {
      this.patrolIdx++;
      this.pauseT = 1.6 + Math.random() * 3.2;
      this.baseYaw = this.yaw;
      this.scanPhase = 0;
      this.path = null;
      return;
    }
    if (this.pathAge <= 0 || !this.path) { this.setPath(wp[0], wp[1]); this.pathAge = 1.5; }
    this.pathAge -= dt;
    this.followPath(dt, this.speed * 0.55);
  }

  doEngage(dt, seen) {
    const g = this.game;
    if (!this.target || !this.target.alive) {
      this.target = this.pickTarget(50, 'squad') || this.pickTarget(50);
      if (!this.target) {
        this.vel = 0;
        this.scanPhase += dt * 2;
        this.targetYaw = this.yaw + Math.sin(this.scanPhase) * 1.6;
        if (this.morale > 0.5) this.state = 'alert';
        return;
      }
    }
    const d = dist2D(this.pos.x, this.pos.z, this.target.pos.x, this.target.pos.z);
    const visible = this.canSee(this.target, 60, undefined);

    /* 找掩体：由 coverTimer 统一节流。
       原来的条件写成 `(!this.coverPos || this.coverTimer <= 0)` —— 只要 coverPos 为空，
       前半段就恒为真，于是「找不到掩体」或「掩体被判定不可达而清空」时，
       会变成每帧（50% 概率）调用一次 findCoverFor + setPath。
       改成只看 coverTimer，并让它在每次搜索后（无论成功与否）都重置。 */
    if (this.coverTimer === undefined) this.coverTimer = 0;
    this.coverTimer -= dt;
    if (visible && this.coverTimer <= 0 && Math.random() < 0.5) {
      this.coverTimer = 2.6 + Math.random() * 2.2;
      const c = g.findCoverFor(this, this.target, d);
      if (c) this.coverPos = c;
    }
    if (this.coverPos) {
      const cd = dist2D(this.pos.x, this.pos.z, this.coverPos.x, this.coverPos.z);
      if (cd > 0.8) {
        if (!this.path || this.pathAge <= 0) {
          /* setPath 返回 null 说明这个掩体不在导航网格上（或不可达）。
             此时 this.path 恒为 null，若不做处理就会每帧触发一次全量 A*
             （最多 5200 节点、open list 线性扫描），并且原先的 return 会跳过
             下面的瞄准与开火段 —— 嫌疑人卡死在原地、再也不开枪。
             这里的做法是直接放弃这个掩体并加冷却，让 AI 回落到常规分支。 */
          if (!this.setPath(this.coverPos.x, this.coverPos.z)) {
            this.coverPos = null;
            this.coverTimer = 1.5;      // 冷却：不要因为「掩体被清空」就立刻重新搜一遍
            this.pathAge = 0;
          } else {
            this.pathAge = 2.0;
          }
        }
        this.pathAge -= dt;
        /* 不再 return：即便在向掩体移动，也要继续执行瞄准与开火 */
        if (this.coverPos) {
          this.followPath(dt, this.speed * 1.25);
          this.targetYaw = Math.atan2(-(this.target.pos.x - this.pos.x), -(this.target.pos.z - this.pos.z));
          this.updateEngageFire(dt, visible);
          return;
        }
      } else {
        this.vel = 0;
        this.crouch = true;
      }
    } else if (!visible && d > 14) {
      // 逼近
      if (!this.path || this.pathAge <= 0) { this.setPath(this.target.pos.x, this.target.pos.z); this.pathAge = 1.8; }
      this.pathAge -= dt;
      this.followPath(dt, this.speed * 1.1);
    } else {
      /* 已进入交火距离且无掩体可用：站定射击。
         注意：这里原本写了 this.strafe 的赋值，但全项目没有任何地方读它 ——
         属于自欺欺人的死代码（读者会以为敌人在侧移，其实站着不动）。
         真要加侧移，就用 moveDir 沿目标垂线移动；在那之前不保留假实现。 */
      this.vel = 0;
    }

    this.targetYaw = Math.atan2(-(this.target.pos.x - this.pos.x), -(this.target.pos.z - this.pos.z));

    this.updateEngageFire(dt, visible);
  }

  /* 交火开火：3~5 连发点射，发间 0.11s，点射之间用 burstGap 停顿。
     旧实现把 `fireCd <= 0` 放在最前面判，于是续点射需要 `0 < fireCd <= 0.02`
     这个极窄窗口，实际退化成节拍器式单发（~545rpm）+ 偶发杂散点射；
     burstGap 被赋值却从未被读取。 */
  updateEngageFire(dt, visible) {
    if (this.fireCd > 0) return;
    const aimAt = this.seenTarget;
    const canShoot = !!aimAt && aimAt.alive && this.awareness >= 1 &&
      this.canSee(aimAt, 60, undefined);
    if (!canShoot) {
      this.burstLeft = 0;
      this.fireCd = 0.4 + Math.random() * 0.4;
      return;
    }
    const d2 = dist2D(this.pos.x, this.pos.z, aimAt.pos.x, aimAt.pos.z);
    const spread = (this.elite ? 0.030 : 0.048) + d2 * 0.0022 + this.suppression * 0.03;
    this.shootAt(aimAt, spread, 1, 0xffb27a);
    this.burstLeft--;
    if (this.burstLeft > 0) {
      this.fireCd = 0.11;                              // 点射内间隔
    } else {
      this.burstLeft = 3 + Math.floor(Math.random() * 3);   // 下一轮 3~5 发
      this.fireCd = this.burstGap;                     // 点射之间的停顿
      this.burstGap = 0.55 + Math.random() * 0.5;
    }
  }

  surrender() {
    if (this.surrendered || this.detained || !this.alive) return;
    this.surrendered = true;
    this.state = 'surrender';
    this.vel = 0;
    this.game.onSuspectSurrender(this);
  }
}

/* ============================================================
   平民
   ============================================================ */
export class Civilian extends Actor {
  constructor(game, cfg) {
    super(game, {
      kind: 'civilian', name: cfg.label || '平民', x: cfg.x, z: cfg.z,
      yaw: Math.random() * TAU, hp: 60, speed: 1.5,
    });
    this.state = 'cower';
    this.label = cfg.label;
    this.threat = null;
    this.panicT = 0;
    this.safe = false;
    this.escorted = false;
    this.crouch = true;
    this.tremble = Math.random() * TAU;
    this.hasCalled = false;
  }

  panic() {
    if (this.safe || this.escorted || !this.alive) return;
    this.panicT = Math.max(this.panicT, 4 + Math.random() * 3);
    this.state = 'panic';
  }

  update(dt) {
    if (!this.alive || this.safe) return;
    this.updateCommon(dt);
    const g = this.game;
    this.tremble += dt * 6;

    if (!this.hasCalled && g.player && dist2D(this.pos.x, this.pos.z, g.player.pos.x, g.player.pos.z) < 26) {
      this.hasCalled = true;
      g.civilianCall(this);
    }

    if (this.escorted) {
      this.crouch = false;
      const sz = g.world.safeZone;
      const tx = (sz.x0 + sz.x1) / 2, tz = (sz.z0 + sz.z1) / 2;
      if ((this.pathAge -= dt) <= 0 || !this.path) { this.setPath(tx, tz); this.pathAge = 2.4; }
      const done = this.followPath(dt, 1.95);
      if (done || (this.pos.z > sz.z0 - 1 && Math.abs(this.pos.x) < 12)) {
        this.safe = true;
        this.group.visible = false;
        if (this.marker) this.marker.visible = false;
        g.onCivilianSafe(this);
      }
      this.animate(dt); this.syncTransform();
      return;
    }

    if (this.panicT > 0) {
      this.panicT -= dt;
      this.crouch = false;
      // 远离威胁
      let tx = this.pos.x, tz = this.pos.z;
      const src = this.threat;
      if (src) {
        const dx = this.pos.x - src.x, dz = this.pos.z - src.z;
        const d = Math.hypot(dx, dz) || 1;
        tx = this.pos.x + (dx / d) * 8;
        tz = this.pos.z + (dz / d) * 8;
      }
      if (!this.path || this.pathAge <= 0) { this.setPath(tx, tz); this.pathAge = 1.4; }
      this.pathAge -= dt;
      this.followPath(dt, 2.6);
      if (this.panicT <= 0) { this.state = 'cower'; this.path = null; }
    } else {
      this.state = 'cower';
      this.crouch = true;
      this.vel = 0;
      // 面向最近的小队成员
      let nearest = g.player, nd = Infinity;
      for (const a of g.squad.concat([g.player])) {
        if (!a.alive) continue;
        const d = dist2D(this.pos.x, this.pos.z, a.pos.x, a.pos.z);
        if (d < nd) { nd = d; nearest = a; }
      }
      if (nearest) this.targetYaw = Math.atan2(-(nearest.pos.x - this.pos.x), -(nearest.pos.z - this.pos.z));
      if (this.parts.torso) this.parts.torso.rotation.z = Math.sin(this.tremble) * 0.03;
    }

    // 检测威胁
    if (!this.threat || Math.random() < dt) {
      let t = null, td = 30;
      for (const s of g.suspects) {
        if (!s.alive) continue;
        const d = dist2D(this.pos.x, this.pos.z, s.pos.x, s.pos.z);
        if (d < td) { td = d; t = s; }
      }
      this.threat = t ? { x: t.pos.x, z: t.pos.z } : null;
      if (t && td < 14 && this.panicT <= 0) this.panic();
    }

    this.yaw = angleDamp(this.yaw, this.targetYaw, 4, dt);
    this.animate(dt);
    this.syncTransform();
  }
}
