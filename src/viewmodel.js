/* ============================================================
   viewmodel.js — 第一人称武器模型（摆动 / 举枪 / 换弹 / 后坐）
   ============================================================ */
import * as THREE from 'three';
import { WEAPONS } from './data.js';
import { feel } from './feel.js';

const MAT = {
  body:  new THREE.MeshStandardMaterial({ color: 0x565f6a, roughness: 0.46, metalness: 0.42 }),
  poly:  new THREE.MeshStandardMaterial({ color: 0x454e58, roughness: 0.68, metalness: 0.14 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x2e353d, roughness: 0.34, metalness: 0.62 }),
  wood:  new THREE.MeshStandardMaterial({ color: 0x6d5335, roughness: 0.72, metalness: 0.05 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x394454, roughness: 0.86, metalness: 0.04 }),
  glow:  new THREE.MeshStandardMaterial({ color: 0xcaf7ff, emissive: 0x5fd0e6, emissiveIntensity: 1.1 }),
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export class ViewModel {
  constructor(game, camera) {
    this.game = game;
    this.mainCamera = camera;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.008, 12);
    this.scene.add(this.camera);
    this.root = new THREE.Group();
    this.root.scale.setScalar(0.62);
    this.camera.add(this.root);
    this.models = {};
    this.current = null;
    this.t = 0;
    this.recoilZ = 0;
    this.recoilPitch = 0;
    this.reloadT = 0;
    this.lag = { x: 0, y: 0 };
    this.lastYaw = 0; this.lastPitch = 0;

    // 专用光照，保证第一人称武器始终可读
    const key = new THREE.DirectionalLight(0xe6f0fb, 1.35);
    key.position.set(-0.7, 0.9, 0.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x86c8ff, 0.85);
    rim.position.set(0.9, 0.2, -0.8);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0x5f7d95, 0x141a20, 0.75));
    const warm = new THREE.PointLight(0xffc98a, 0.7, 3.5, 2);
    warm.position.set(-0.4, -0.3, -0.2);
    this.scene.add(warm);

    for (const id of ['mr4', 'vk12', 'k9', 'p9', 'r7']) {
      this.models[id] = this.build(id);
      this.root.add(this.models[id]);
      this.models[id].visible = false;
    }
    this.setActive('mr4');
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 在主动画之后以清空深度缓冲的方式绘制第一人称武器 */
  render(renderer) {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  build(id) {
    const g = new THREE.Group();
    const d = WEAPONS[id];
    const isPistol = d.cls === 'sidearm';
    const scale = 1;
    if (isPistol) {
      g.add(box(0.045, 0.075, 0.20, MAT.metal, 0, 0, -0.02));
      g.add(box(0.04, 0.115, 0.055, MAT.poly, 0, -0.085, 0.055));
      g.add(box(0.02, 0.02, 0.09, MAT.metal, 0, 0.045, -0.08));
      g.add(box(0.014, 0.014, 0.014, MAT.glow, 0, 0.065, -0.10));
    } else {
      g.add(box(0.075, 0.105, 0.44, MAT.body, 0, 0, 0));                    // 机匣
      g.add(box(0.062, 0.072, 0.30, MAT.poly, 0, 0.008, -0.36));            // 护木
      const barrel = box(0.028, 0.028, 0.46, MAT.metal, 0, 0.012, -0.62); g.add(barrel);
      const muzzle = box(0.042, 0.042, 0.07, MAT.metal, 0, 0.012, -0.82);
      muzzle.name = 'muzzle'; g.add(muzzle);
      g.add(box(0.05, 0.20, 0.10, MAT.metal, 0, -0.16, 0.0));               // 弹匣
      if (d.id === 'vk12') g.children[g.children.length - 1].scale.set(0.9, 0.7, 0.9);
      g.add(box(0.05, 0.13, 0.055, MAT.poly, 0, -0.10, 0.16));              // 握把
      g.add(box(0.055, 0.085, 0.26, MAT.poly, 0, 0.005, 0.40));             // 枪托
      g.add(box(0.03, 0.045, 0.13, MAT.glow, 0, 0.075, -0.16));             // 光点
      g.add(box(0.05, 0.055, 0.10, MAT.metal, 0, 0.085, 0.04));             // 光学
      g.add(box(0.036, 0.03, 0.012, MAT.glow, 0, 0.09, -0.05));
      g.add(box(0.035, 0.09, 0.035, MAT.poly, 0, -0.075, -0.24));           // 前握把
    }
    // 双手
    g.add(box(0.075, 0.075, 0.115, MAT.glove, 0.005, -0.115, 0.135));
    g.add(box(0.075, 0.075, 0.12, MAT.glove, -0.005, -0.075, isPistol ? 0.0 : -0.30));
    g.scale.setScalar(scale);
    return g;
  }

  setActive(id) {
    if (!this.models[id]) id = 'mr4';
    if (this.current) this.current.visible = false;
    this.current = this.models[id];
    this.current.visible = true;
  }

  get isPistol() { return this.current === this.models.p9 || this.current === this.models.r7; }

  /** 枪口在世界空间的位置（供曳光弹与枪口火光使用） */
  muzzleWorld(out) {
    const m = this.current.getObjectByName('muzzle') || this.current;
    this.scene.updateMatrixWorld(true);
    const v = out || new THREE.Vector3();
    m.getWorldPosition(v);
    this.mainCamera.updateMatrixWorld(true);
    v.applyMatrix4(this.mainCamera.matrixWorld);
    return v;
  }

  update(dt, player, input) {
    this.t += dt;
    const d = player.def;
    this.setActive(d.id);

    // 鼠标滞后
    const dyaw = player.yaw - this.lastYaw;
    const dpitch = player.pitch - this.lastPitch;
    this.lastYaw = player.yaw; this.lastPitch = player.pitch;
    this.lag.x += (-dyaw * feel.viewmodel.lagYaw - this.lag.x) * Math.min(1, dt * feel.viewmodel.lagDamp);
    this.lag.y += (-dpitch * feel.viewmodel.lagPitch - this.lag.y) * Math.min(1, dt * feel.viewmodel.lagDamp);

    // 后坐
    this.recoilZ *= Math.exp(-dt * 9);
    this.recoilPitch *= Math.exp(-dt * 8);

    // 换弹进度
    if (player.reloading > 0) this.reloadT = Math.min(1, 1 - player.reloading / d.reload);
    else this.reloadT = Math.max(0, this.reloadT - dt * 4);

    const ads = player.ads;
    const bobX = Math.sin(player.bob) * feel.viewmodel.bobAmpX * player.moving * (1 - ads * feel.viewmodel.bobAdsDamp);
    const bobY = Math.abs(Math.cos(player.bob)) * feel.viewmodel.bobAmpY * player.moving * (1 - ads * feel.viewmodel.bobAdsDamp);

    // 位置以「光学瞄具位于视线轴上」为准
    const hipPos = this.isPistol
      ? new THREE.Vector3(0.215, -0.165, -0.44)
      : new THREE.Vector3(0.245, -0.195, -0.55);
    const adsPos = this.isPistol
      ? new THREE.Vector3(0.0, -0.050, -0.42)
      : new THREE.Vector3(0.0, -0.053, -0.44);
    const pos = hipPos.lerp(adsPos, ads);
    pos.x += this.lag.x + bobX;
    pos.y += this.lag.y + bobY - this.reloadT * 0.16;
    pos.z += this.recoilZ;

    const hipRot = new THREE.Euler(0.02, this.isPistol ? -0.10 : -0.06, this.isPistol ? 0.02 : 0.035);
    const adsRot = new THREE.Euler(0, 0, 0);
    this.root.position.copy(pos);
    this.root.rotation.set(
      hipRot.x + (adsRot.x - hipRot.x) * ads + this.recoilPitch + this.reloadT * 0.5,
      hipRot.y + (adsRot.y - hipRot.y) * ads,
      hipRot.z + (adsRot.z - hipRot.z) * ads + this.reloadT * 0.25 + this.lag.x * 0.6,
    );
    if (this.isPistol && ads > 0.9) this.root.position.x += 0.0;
    // 冲刺时压枪
    if (player.stance === 'sprint') {
      this.root.position.y -= feel.viewmodel.sprintDrop;
      this.root.rotation.x += feel.viewmodel.sprintTilt;
    }
  }

  kick(amount) {
    this.recoilZ += feel.viewmodel.recoilKickZ * amount;
    this.recoilPitch += feel.viewmodel.recoilKickPitch * amount;
  }
}
