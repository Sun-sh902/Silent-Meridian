/* ============================================================
   player.js — 队长控制器：移动、观察、射击、互动
   ============================================================ */
import * as THREE from 'three';
import { Actor } from './actors.js';
import { clamp, angleDamp, dist2D, TAU } from './geom.js';
import { castRay } from './combat.js';
import { WEAPONS, GADGETS, ARMORS, TUNING } from './data.js';
import { feel } from './feel.js';

export class Player extends Actor {
  constructor(game, cfg) {
    super(game, {
      kind: 'player', name: '队长', callsign: 'LEAD',
      x: cfg.x, z: cfg.z, yaw: cfg.yaw, hp: cfg.hp || 120, speed: 3.0,
    });
    this.pitch = 0;
    this.primaryDef = WEAPONS[cfg.loadout.primary];
    this.sidearmDef = WEAPONS[cfg.loadout.sidearm];
    this.gadgetDef = GADGETS[cfg.loadout.gadget];
    this.armor = ARMORS[cfg.loadout.armor];
    this.maxHp = this.armor.hp;
    this.hp = this.maxHp;
    this.mag = { primary: this.primaryDef.mag, sidearm: this.sidearmDef.mag };
    this.reserve = { primary: this.primaryDef.reserve, sidearm: this.sidearmDef.reserve };
    this.gadgetCount = this.gadgetDef.count;
    this.active = 'primary';
    this.ads = 0;
    this.reloading = 0;
    this.fireCd = 0;
    this.bob = 0;
    this.sway = { x: 0, y: 0 };
    this.recoil = { pitch: 0, yaw: 0 };
    this.moving = 0;
    this.stance = 'walk';
    this.blind = 0;
    this.throwCharge = 0;
    this.stamina = 1;
    this.burstCount = 0;
    this.shotsFired = 0;
    /* 诊断用记录字段：默认关闭，不参与任何判定逻辑 */
    this.lastSpread = 0;
    this.lastShotIndex = 0;
    this.logShots = false;        // 打开后逐发记录弹道，用于「可学习弹道」验算
    this.shotLog = [];
    this.legPhase = 0;
  }

  get def() { return this.active === 'primary' ? this.primaryDef : this.sidearmDef; }

  /* ---------------- 视角 ---------------- */
  look(dx, dy) {
    const sens = feel.camera.sensBase * (1 - this.ads * feel.camera.adsSensMul);
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch - dy * sens, -1.45, 1.45);
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;
  }

  get forward() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: sp, z: -Math.cos(this.yaw) * cp };
  }

  /* ---------------- 每帧 ---------------- */
  update(dt, input) {
    if (!this.alive) return;
    this.updateCommon(dt);
    const g = this.game;
    this.stamina = clamp(this.stamina + dt * feel.move.staminaRegen, 0, 1);

    /* --- 移动 --- */
    let fx = 0, fz = 0;
    if (input.keys.has('KeyW')) fz -= 1;
    if (input.keys.has('KeyS')) fz += 1;
    if (input.keys.has('KeyA')) fx -= 1;
    if (input.keys.has('KeyD')) fx += 1;
    const len = Math.hypot(fx, fz);
    let speedMul = 1;
    const sprinting = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
    const sneaking = input.keys.has('ControlLeft') || input.keys.has('ControlRight');
    if (sprinting && this.stamina > feel.move.staminaMin && fz < feel.move.sprintFwdGate) {
      speedMul = feel.move.sprintMul; this.stance = 'sprint';
      this.stamina = clamp(this.stamina - dt * feel.move.staminaDrain, 0, 1);
    } else if (sneaking) { speedMul = feel.move.crouchMul; this.stance = 'sneak'; }
    else this.stance = 'walk';

    const base = feel.move.walkSpeed * this.armor.speed * (this.ads > feel.move.adsGate ? feel.move.adsSpeedMul : 1);
    if (len > 0) {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const wx = (fx / len) * cy + (fz / len) * sy;
      const wz = -(fx / len) * sy + (fz / len) * cy;
      this.moveDir(wx, wz, base * speedMul, dt);
      this.legPhase += dt * (6 + speedMul * 4);
      this.bob += dt * (feel.camera.bobSpeedBase + speedMul * feel.camera.bobSpeedPerMove);
      this.moving = clamp(this.moving + dt * 4, 0, 1);
    } else {
      this.vel = 0;
      this.moving = clamp(this.moving - dt * 5, 0, 1);
      this.bob += dt * feel.camera.bobSpeedIdle;
    }

    /* --- 瞄准 --- */
    const wantAds = input.rmb && this.reloading <= 0 && this.alive;
    this.ads = clamp(this.ads + (wantAds ? dt * feel.reload.adsInSpeed : -dt * feel.reload.adsOutSpeed), 0, 1);

    /* --- 换弹 --- */
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const d = this.def;
        const need = d.mag - this.mag[this.active];
        const take = Math.min(need, this.reserve[this.active]);
        this.mag[this.active] += take;
        this.reserve[this.active] -= take;
        g.audio.reloadDone();
      }
    }

    /* --- 射击 --- */
    if (this.fireCd > 0) this.fireCd -= dt;
    if (this.blind > 0) this.blind -= dt;
    const canFire = this.alive && this.reloading <= 0 && this.fireCd <= 0 && this.blind <= 0;
    const d = this.def;
    if ((input.lmb || input.lmbPressed) && canFire && !g.paused) {
      if (d.mode === 'SEMI' || d.mode === 'REVOLVER' || d.mode === 'PUMP') {
        if (input.lmbPressed) this.fireOnce();   // 一次点击 = 一发
      } else {
        this.fireOnce();
      }
    }
    if (!input.lmb) this.burstCount = 0;

    /* --- 后坐恢复 --- */
    this.recoil.pitch *= Math.exp(-dt * feel.weapon.recoilDecayPitch);
    this.recoil.yaw *= Math.exp(-dt * feel.weapon.recoilDecayYaw);
    this.pitch = clamp(this.pitch + this.recoil.pitch * dt * feel.weapon.recoilPitchToAim, -1.45, 1.45);
    this.yaw += this.recoil.yaw * dt * feel.weapon.recoilYawToAim;

    /* --- 走动摆动 --- */
    const bobAmt = this.moving * (1 - this.ads * feel.camera.swayAdsDamp) * (this.stance === 'sprint' ? feel.camera.sprintBobMul : 1.0);
    this.sway.x = Math.sin(this.bob) * feel.camera.swayAmpX * bobAmt;
    this.sway.y = Math.abs(Math.cos(this.bob)) * feel.camera.swayAmpY * bobAmt;

    /* --- 投掷蓄力 --- */
    if (input.keys.has('KeyG')) this.throwCharge = Math.min(1, this.throwCharge + dt * 1.6);
    else if (this.throwCharge > 0) { this.throwGadget(this.throwCharge); this.throwCharge = 0; }

    this.syncTransform();
  }

  fireOnce() {
    const d = this.def;
    if (this.mag[this.active] <= 0) {
      this.game.audio.dryFire();
      this.fireCd = 0.28;
      this.game.log('弹匣已空 — 按 R 换弹', 'warn');
      return;
    }
    this.mag[this.active]--;
    this.shotsFired++;
    const rate = 60 / d.rpm;
    this.fireCd = rate;
    this.game.weaponsFree = true;
    this.game.stats.shots++;

    const spreadBase = this.ads > feel.spread.adsSpreadGate ? d.adsSpread : d.spread;
    const movePenalty = this.moving * (d.moveSpread || 0.02) * feel.spread.moveSpreadMul * (this.stance === 'sprint' ? feel.spread.sprintSpreadMul : 1);
    const pellets = d.pellets || 1;
    this.lastSpread = spreadBase + movePenalty + this.recoil.pitch * feel.spread.recoilToSpread + (this.suppression * feel.spread.suppressionToSpread);
    for (let i = 0; i < pellets; i++) {
      const f = this.forward;
      let dx = f.x, dy = f.y, dz = f.z;
      const spread = spreadBase + movePenalty + this.recoil.pitch * feel.spread.recoilToSpread + (this.suppression * feel.spread.suppressionToSpread);
      const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * spread;
      let rx = -f.z, rz = f.x;
      const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      const ux = -f.y * rz, uy = f.x * rx + f.z * rz, uz = f.y * rx;
      dx += rx * Math.cos(a) * r + ux * Math.sin(a) * r;
      dy += uy * Math.sin(a) * r;
      dz += rz * Math.cos(a) * r + uz * Math.sin(a) * r;
      const dl = Math.hypot(dx, dy, dz);
      const hit = castRay(this.game, this.eye.x, this.eye.y, this.eye.z, dx / dl, dy / dl, dz / dl, d.range, this);
      if (hit.actor) {
        hit.actor.takeDamage(d.damage, this, hit.point);
        this.game.onPlayerHit(hit.actor, hit.point);
        this.game.stats.hits++;
        this.game.effects.impact(hit.point, 0xff9a72, 0.85);
      } else if (hit.wall) {
        this.game.effects.impact(hit.point, 0xffd7a0, 0.6);
      }
      this.game.effects.tracer(
        { x: this.eye.x + dx * 0.8, y: this.eye.y - 0.1, z: this.eye.z + dz * 0.8 },
        hit.point, 0xffe6bd);
    }
    this.game.effects.muzzle(this.muzzleWorld(), 1.2 * d.muzzle);
    this.game.audio.gunshot(d.id, this.ads > 0.5);
    this.game.shake(feel.feedback.shakeKick * d.recoil, 0.12);
    this.recoil.pitch += d.recoil * (this.ads > feel.move.adsGate ? feel.weapon.recoilAdsMul : 1) * feel.weapon.recoilKickPitch;
    this.recoil.yaw += (Math.random() - 0.5) * d.recoil * feel.weapon.recoilJitterYaw;
    this.lastShotIndex++;
    if (this.logShots) this.shotLog.push({ s: this.lastSpread, p: this.recoil.pitch, y: this.recoil.yaw });
    this.game.onPlayerShot();

    if (this.mag[this.active] === 0) this.game.log('弹匣已空 — 按 R 换弹', 'warn');
  }

  muzzleWorld() {
    const vm = this.game.viewmodel;
    if (vm && vm.muzzleWorld) {
      const v = vm.muzzleWorld();
      return { x: v.x, y: v.y, z: v.z };
    }
    const f = this.forward, r = { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };
    return {
      x: this.eye.x + f.x * 1.0 + r.x * 0.16,
      y: this.eye.y + f.y * 1.0 - 0.12,
      z: this.eye.z + f.z * 1.0 + r.z * 0.16,
    };
  }

  startReload() {
    if (this.reloading > 0) return;
    const d = this.def;
    if (this.mag[this.active] >= d.mag || this.reserve[this.active] <= 0) return;
    this.reloading = d.reload * feel.reload.reloadScale;
    this.ads = 0;
    this.game.audio.reloadStart();
    this.game.log(`换弹 — ${d.short}`, '');
  }

  switchWeapon() {
    this.active = this.active === 'primary' ? 'sidearm' : 'primary';
    this.reloading = 0;
    this.fireCd = feel.reload.switchFireCd;
    this.game.audio.click();
    this.game.log(`切换武器 — ${this.def.short}`, '');
  }

  throwGadget(power) {
    const g = this.game;
    if (this.gadgetCount <= 0) { g.log('战术器材已耗尽', 'warn'); return; }
    const d = this.gadgetDef;
    this.gadgetCount--;
    const f = this.forward;
    const p = { x: this.eye.x + f.x * 0.6, y: this.eye.y + f.y * 0.6, z: this.eye.z + f.z * 0.6 };
    const spd = 9 + power * 9;
    const mesh = new THREE.Mesh(
      d.id === 'smoke'
        ? new THREE.CylinderGeometry(0.06, 0.06, 0.18, 8)
        : new THREE.CylinderGeometry(0.05, 0.05, 0.15, 8),
      new THREE.MeshStandardMaterial({
        color: d.id === 'smoke' ? 0x8a9298 : d.id === 'breach' ? 0xb03028 : 0xd8d2b8,
        roughness: 0.6, metalness: 0.3,
      }));
    g.scene.add(mesh);
    g.projectiles.push({
      type: d.id, x: p.x, y: p.y, z: p.z,
      vx: f.x * spd, vy: f.y * spd + 1.6, vz: f.z * spd,
      fuse: d.fuse, radius: d.radius, mesh, rest: false, spin: 0,
    });
    g.audio.throwItem();
    g.log(`投掷 ${d.short}`, '');
    g.stats.gadgets++;
  }

  /* ---------------- 互动 ---------------- */
  findInteraction() {
    const g = this.game;
    const eye = this.eye;
    // 1. 目标：拘押 / 护送 / 救援
    let best = null, bestD = 3.4;
    for (const a of g.actors) {
      if (a === this || a.safe) continue;
      const d = dist2D(this.pos.x, this.pos.z, a.pos.x, a.pos.z);
      if (d > bestD) continue;
      if (a.kind === 'suspect' && a.alive && a.surrendered && !a.detained) {
        best = { label: `拘押 ${a.name}`, action: 'detain', target: a, d };
      } else if (a.kind === 'civilian' && a.alive && !a.escorted) {
        if (!best || best.action !== 'detain') best = { label: `护送平民撤离（${a.label}）`, action: 'escort', target: a, d };
      } else if (a.kind === 'squad' && !a.alive && a.revivable() && this.gadgetDef.id === 'trauma' && this.gadgetCount > 0) {
        if (!best || best.action === 'escort') best = { label: `急救 ${a.callsign}`, action: 'revive', target: a, d };
      }
    }
    // 2. 任务物品
    for (const key of ['manifest', 'evidence']) {
      const o = g.objectiveProps[key];
      if (!o || o.taken) continue;
      const d = dist2D(this.pos.x, this.pos.z, o.x, o.z);
      if (d < 2.6 && (!best || best.action !== 'detain')) {
        best = { label: `取回${o.label}`, action: 'take', key, target: o, d };
      }
    }
    return best;
  }

  doInteract() {
    const it = this.findInteraction();
    if (!it) return;
    const g = this.game;
    if (it.action === 'detain') {
      it.target.detained = true;
      it.target.surrendered = false;
      it.target.state = 'detained';
      g.onDetained(it.target);
    } else if (it.action === 'escort') {
      it.target.escorted = true;
      it.target.crouch = false;
      it.target.setPath((g.world.safeZone.x0 + g.world.safeZone.x1) / 2, g.world.safeZone.z1 - 2);
      g.onEscortStarted(it.target);
    } else if (it.action === 'revive') {
      this.gadgetCount--;
      it.target.revive();
      g.stats.revives++;
    } else if (it.action === 'take') {
      g.onObjectiveTaken(it.key, it.target);
    }
  }

  /* ---------------- 相机 ---------------- */
  applyCamera(camera) {
    if (!this.alive) {
      // 倒地视角
      camera.position.set(this.pos.x, 0.42, this.pos.z);
      camera.rotation.set(0, 0, 0);
      camera.rotateY(this.yaw);
      camera.rotateX(-0.22);
      camera.rotateZ(1.15);
      camera.fov += (78 - camera.fov) * 0.12;
      camera.updateProjectionMatrix();
      return;
    }
    const eye = this.eye;
    const hb = feel.camera.headBobEnabled ? 1 : 0;
    const bobY = this.moving * (1 - this.ads * feel.camera.bobAdsDamp) * feel.camera.bobAmpY * Math.sin(this.bob * 2) * hb;
    const bobX = this.moving * (1 - this.ads * feel.camera.bobAdsDamp) * feel.camera.bobAmpX * Math.sin(this.bob) * hb;
    camera.position.set(eye.x + bobX * Math.cos(this.yaw), eye.y + bobY + this.game.camShakeY, eye.z - bobX * Math.sin(this.yaw));
    camera.rotation.set(0, 0, 0);
    camera.rotateY(this.yaw);
    camera.rotateX(this.pitch);
    camera.rotateZ(this.moving * feel.camera.rollAmp * Math.sin(this.bob) * hb + this.game.camShakeZ);
    const adsFov = feel.camera.adsFovOverride > 0 ? feel.camera.adsFovOverride : this.def.adsFov;
    const targetFov = this.ads > feel.move.adsGate ? adsFov
      : (this.stance === 'sprint' ? feel.camera.fovSprint : feel.camera.fovDefault);
    camera.fov += (targetFov - camera.fov) * 0.18;
    camera.updateProjectionMatrix();
  }
}
