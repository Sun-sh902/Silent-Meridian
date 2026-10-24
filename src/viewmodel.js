/* ============================================================
   viewmodel.js — first-person weapon model (sway / ADS / reload / recoil)
   ============================================================ */
import * as THREE from 'three';
import { WEAPONS } from './data.js';
import { feel } from './feel.js';

/* Three clearly different material families, because a real carbine is three: hard-anodised aluminium
   (receiver, handguard, rail, optic body), parkerised steel (barrel, muzzle device, bolt, pins) and
   glass-filled polymer (grip, stock, magazine, foregrip). Values are physical, not tuned for brightness:
   the weapon is lit by the same world as everything else (see syncLights). */
const MAT = {
  anod:   new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.42, metalness: 0.6 }),
  steel:  new THREE.MeshStandardMaterial({ color: 0x45484b, roughness: 0.5, metalness: 0.85 }),
  bright: new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: 0.28, metalness: 1.0 }),   // worn edges, bolt face
  poly:   new THREE.MeshStandardMaterial({ color: 0x252725, roughness: 0.74, metalness: 0 }),
  wood:   new THREE.MeshStandardMaterial({ color: 0x5a3f27, roughness: 0.62, metalness: 0 }),
  glove:  new THREE.MeshPhysicalMaterial({ color: 0x26292c, roughness: 0.88, metalness: 0, sheen: 0.5, sheenRoughness: 0.7, sheenColor: 0x4a4e52 }),
  sleeve: new THREE.MeshPhysicalMaterial({ color: 0x36506e, roughness: 0.85, metalness: 0, sheen: 0.6, sheenRoughness: 0.8, sheenColor: 0x5a7090 }),
  cuff:   new THREE.MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.7, metalness: 0 }),
  /* optic glass: dielectric with an anti-reflection coating (thin-film iridescence), mostly transparent so
     aiming down sights looks through the tube; Fresnel makes it reflect at grazing angles */
  lens:   new THREE.MeshPhysicalMaterial({
    color: 0x0c1416, roughness: 0.03, metalness: 0, ior: 1.6, transparent: true, opacity: 0.32,
    iridescence: 0.7, iridescenceIOR: 1.4, depthWrite: false,
  }),
  tubeIn: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9, metalness: 0, side: THREE.BackSide }),
  /* the only emissive parts: an illuminated reticle and tritium pistol sights are real light sources */
  reticle: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a18).multiplyScalar(3) }),
  tritium: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x7cff9a).multiplyScalar(1.6) }),
};

/* temporaries reused in update(): no per-frame allocation */
const _vmHip = new THREE.Vector3();
const _vmAds = new THREE.Vector3();

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
/* cylinder along Z (barrels, tubes) */
function tubeZ(r0, r1, len, mat, x, y, z, seg = 16, open = false) {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, open);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}
const _up = new THREE.Vector3(0, 1, 0);
/* tapered limb from `from` along `dir` for `len` (forearms); r0 at the wrist, r1 at the far end */
function limb(from, dir, len, r0, r1, mat) {
  const d = dir.clone().normalize();
  const g = new THREE.CylinderGeometry(r0, r1, len, 12, 1, false);
  const m = new THREE.Mesh(g, mat);
  m.quaternion.setFromUnitVectors(_up, d.clone().negate());
  m.position.copy(from).addScaledVector(d, len / 2);
  return m;
}
/* a gloved hand closed around a grip: palm, wrapped fingers, thumb, then cuff and sleeve running off-screen */
function arm(g, hand, toBody, side) {
  const h = new THREE.Group();
  h.position.copy(hand);
  h.add(box(0.072, 0.07, 0.1, MAT.glove, 0, 0, 0));                         // palm and back of hand
  h.add(box(0.078, 0.05, 0.034, MAT.glove, 0, -0.012, -0.055));             // fingers wrapped round the front
  h.add(box(0.026, 0.03, 0.07, MAT.glove, -0.04 * side, 0.03, -0.01));      // thumb along the receiver side
  g.add(h);
  const wrist = hand.clone().add(new THREE.Vector3(0.012 * side, -0.02, 0.05));
  g.add(limb(wrist, toBody, 0.07, 0.043, 0.047, MAT.cuff));                 // glove cuff
  g.add(limb(wrist.clone().addScaledVector(toBody.clone().normalize(), 0.06), toBody, 0.62, 0.047, 0.066, MAT.sleeve));
}

export class ViewModel {
  /* Free geometry in the private scene.
     These BoxGeometries (box() in the original viewmodel.js) were rebuilt on every deploy,
     and because ViewModel hangs off a private scene rather than the main scene graph,
     the main scene's traverse never reached them — about 70 buffers leaked per redeploy. */
  dispose() {
    if (!this.scene) return;
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.scene.clear();
    this.models = {};
    this.current = null;
    this.root = null;
    this.scene = null;
  }

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
    this._vmPos = new THREE.Vector3();
    this._vmRot = new THREE.Euler();
    this.lastYaw = 0; this.lastPitch = 0;

    /* No private light rig any more. The old four fixed lights (1.35 / 0.85 / 0.75 / 0.7) lit the gun 2–3 stops
       brighter than the world and decoupled it from where you stand. Instead the private scene mirrors the world:
       the same hemisphere and directionals, the same environment map (rotated into camera space), and the two
       strongest nearby lamps/fills as point lights — all transformed into camera space every step in syncLights().
       Under a sodium lamp the gun warms up; in shadow it goes dark; indoors it loses the open sky. */
    this.mirror = {
      hemi: new THREE.HemisphereLight(0xffffff, 0xffffff, 0),
      dirs: [],
      points: [new THREE.PointLight(0xffffff, 0, 0, 2), new THREE.PointLight(0xffffff, 0, 0, 2)],
    };
    this.scene.add(this.mirror.hemi);
    for (let i = 0; i < 4; i++) {
      const d = new THREE.DirectionalLight(0xffffff, 0);
      d.target.position.set(0, 0, 0);
      this.scene.add(d); this.scene.add(d.target);
      this.mirror.dirs.push(d);
    }
    for (const p of this.mirror.points) this.scene.add(p);
    this._cands = [];
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._e = new THREE.Euler();

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

  /** Draw the first-person weapon after the main pass, with the depth buffer cleared */
  render(renderer) {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  build(id) {
    const g = new THREE.Group();
    const d = WEAPONS[id];
    const isPistol = d.cls === 'sidearm';
    if (isPistol) {
      const revolver = id === 'r7';
      g.add(box(0.045, 0.075, 0.20, MAT.steel, 0, 0, -0.02));                // slide / frame top
      g.add(box(0.042, 0.03, 0.18, MAT.poly, 0, -0.048, -0.03));             // frame / dust cover
      const grip = box(0.04, 0.115, 0.055, revolver ? MAT.wood : MAT.poly, 0, -0.088, 0.055);
      grip.rotation.x = -0.2; g.add(grip);
      g.add(box(0.016, 0.012, 0.012, MAT.steel, 0, 0.044, 0.07));            // rear sight
      g.add(box(0.008, 0.014, 0.01, MAT.steel, 0, 0.045, -0.1));             // front sight post
      g.add(box(0.004, 0.004, 0.003, MAT.tritium, 0, 0.049, -0.106));        // tritium insert
      g.add(box(0.003, 0.004, 0.003, MAT.tritium, -0.006, 0.048, 0.064));
      g.add(box(0.003, 0.004, 0.003, MAT.tritium, 0.006, 0.048, 0.064));
      g.add(box(0.047, 0.006, 0.05, MAT.bright, 0, 0.033, -0.01));           // worn slide-top edge
      const muzzle = box(0.022, 0.022, 0.01, MAT.steel, 0, 0.01, -0.125); muzzle.name = 'muzzle'; g.add(muzzle);
      arm(g, new THREE.Vector3(0.005, -0.115, 0.135), new THREE.Vector3(0.25, -0.5, 0.82), 1);
      arm(g, new THREE.Vector3(-0.012, -0.09, 0.07), new THREE.Vector3(-0.42, -0.55, 0.72), -1);
    } else {
      g.add(box(0.075, 0.105, 0.44, MAT.anod, 0, 0, 0));                     // receiver
      g.add(box(0.03, 0.012, 0.40, MAT.anod, 0, 0.058, -0.02));              // top rail
      for (let i = 0; i < 9; i++) g.add(box(0.034, 0.006, 0.008, MAT.anod, 0, 0.066, -0.2 + i * 0.045));   // rail slots
      g.add(box(0.004, 0.03, 0.07, MAT.bright, 0.039, 0.012, -0.03));        // ejection port / bolt carrier
      g.add(box(0.05, 0.012, 0.02, MAT.steel, 0, 0.046, 0.21));              // charging handle
      g.add(box(0.062, 0.072, 0.30, MAT.anod, 0, 0.008, -0.36));             // handguard
      for (let i = 0; i < 4; i++) {
        g.add(box(0.064, 0.014, 0.03, MAT.poly, 0, 0.008, -0.28 - i * 0.055));   // M-LOK slots, both sides
      }
      g.add(tubeZ(0.012, 0.012, 0.46, MAT.steel, 0, 0.012, -0.62));          // barrel
      const muzzle = tubeZ(0.018, 0.018, 0.07, MAT.steel, 0, 0.012, -0.82); muzzle.name = 'muzzle'; g.add(muzzle);
      g.add(tubeZ(0.0185, 0.0185, 0.012, MAT.bright, 0, 0.012, -0.855));     // muzzle crown, worn bright
      const mag = box(0.05, 0.20, 0.10, MAT.poly, 0, -0.16, 0.0);            // magazine
      mag.rotation.x = 0.12;
      if (d.id === 'vk12') mag.scale.set(0.9, 0.7, 0.9);
      g.add(mag);
      const grip = box(0.05, 0.13, 0.055, MAT.poly, 0, -0.10, 0.16); grip.rotation.x = -0.25; g.add(grip);
      g.add(box(0.012, 0.006, 0.06, MAT.steel, 0, -0.06, 0.11));             // trigger guard
      g.add(box(0.055, 0.085, 0.26, MAT.poly, 0, 0.005, 0.40));              // stock
      g.add(tubeZ(0.016, 0.016, 0.12, MAT.anod, 0, 0.02, 0.26));             // buffer tube
      g.add(box(0.035, 0.09, 0.035, MAT.poly, 0, -0.075, -0.24));            // foregrip
      /* optic: a real tube with depth — mount, body, front and recessed rear lenses, a dark inner sleeve and the
         reticle floating at its centre. The tube axis sits at y ≈ 0.087, where ADS puts the line of sight. */
      const oy = 0.087, oz = 0.03;
      g.add(box(0.026, 0.02, 0.07, MAT.anod, 0, 0.066, oz));                 // mount
      g.add(tubeZ(0.022, 0.022, 0.13, MAT.anod, 0, oy, oz, 20, true));       // body (open-ended)
      g.add(tubeZ(0.024, 0.024, 0.018, MAT.anod, 0, oy, oz - 0.058, 20, true));   // objective bell
      g.add(tubeZ(0.0205, 0.0205, 0.12, MAT.tubeIn, 0, oy, oz, 20, true));   // inner sleeve (back faces)
      const lensF = new THREE.Mesh(new THREE.CircleGeometry(0.0205, 20), MAT.lens);
      lensF.position.set(0, oy, oz - 0.06); g.add(lensF);
      const lensR = new THREE.Mesh(new THREE.CircleGeometry(0.0205, 20), MAT.lens);
      lensR.position.set(0, oy, oz + 0.05); g.add(lensR);                    // recessed 15 mm from the eyepiece end
      g.add(box(0.0028, 0.0028, 0.001, MAT.reticle, 0, oy, oz - 0.02));      // illuminated dot
      arm(g, new THREE.Vector3(0.005, -0.115, 0.135), new THREE.Vector3(0.32, -0.55, 0.77), 1);
      arm(g, new THREE.Vector3(-0.005, -0.075, -0.30), new THREE.Vector3(-0.5, -0.55, 0.67), -1);
    }
    return g;
  }

  setActive(id) {
    if (!this.models[id]) id = 'mr4';
    if (this.current) this.current.visible = false;
    this.current = this.models[id];
    this.current.visible = true;
  }

  get isPistol() { return this.current === this.models.p9 || this.current === this.models.r7; }

  /** Muzzle position in world space (for tracers and muzzle flash) */
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

    // mouse lag
    const dyaw = player.yaw - this.lastYaw;
    const dpitch = player.pitch - this.lastPitch;
    this.lastYaw = player.yaw; this.lastPitch = player.pitch;
    this.lag.x += (-dyaw * feel.viewmodel.lagYaw - this.lag.x) * Math.min(1, dt * feel.viewmodel.lagDamp);
    this.lag.y += (-dpitch * feel.viewmodel.lagPitch - this.lag.y) * Math.min(1, dt * feel.viewmodel.lagDamp);

    // recoil
    this.recoilZ *= Math.exp(-dt * 9);
    this.recoilPitch *= Math.exp(-dt * 8);

    // reload progress
    if (player.reloading > 0) this.reloadT = Math.min(1, 1 - player.reloading / d.reload);
    else this.reloadT = Math.max(0, this.reloadT - dt * 4);

    const ads = player.ads;
    const bobX = Math.sin(player.bob) * feel.viewmodel.bobAmpX * player.moving * (1 - ads * feel.viewmodel.bobAdsDamp);
    const bobY = Math.abs(Math.cos(player.bob)) * feel.viewmodel.bobAmpY * player.moving * (1 - ads * feel.viewmodel.bobAdsDamp);

    /* Positioned so the optic sits on the line of sight.
       Vector3/Euler here are assigned in place on instance fields:
       the original allocated 3 Vector3 + 2 Euler per frame (~300 objects/s).
       Values are identical to before; it just no longer allocates. */
    const hip = _vmHip, adsP = _vmAds, pos = this._vmPos, rot = this._vmRot;
    if (this.isPistol) {
      hip.set(0.215, -0.165, -0.44); adsP.set(0.0, -0.050, -0.42);
    } else {
      hip.set(0.245, -0.195, -0.55); adsP.set(0.0, -0.053, -0.44);
    }
    pos.copy(hip).lerp(adsP, ads);
    pos.x += this.lag.x + bobX;
    pos.y += this.lag.y + bobY - this.reloadT * 0.16;
    pos.z += this.recoilZ;

    /* adsRot was always (0,0,0) in the original, so this expands to the hip term times (1-ads) */
    const hx = 0.02, hy = this.isPistol ? -0.10 : -0.06, hz = this.isPistol ? 0.02 : 0.035;
    rot.set(
      hx * (1 - ads) + this.recoilPitch + this.reloadT * 0.5,
      hy * (1 - ads),
      hz * (1 - ads) + this.reloadT * 0.25 + this.lag.x * 0.6,
    );
    this.root.position.copy(pos);
    this.root.rotation.copy(rot);
    // lower the weapon while sprinting
    if (player.stance === 'sprint') {
      this.root.position.y -= feel.viewmodel.sprintDrop;
      this.root.rotation.x += feel.viewmodel.sprintTilt;
    }
    this.syncLights();
  }

  /* Mirror the world's light at the player into the private scene (camera space). Called every step. */
  syncLights() {
    const w = this.game.world;
    if (!w || !w.lights) return;
    const L = w.lights, cam = this.mainCamera, M = this.mirror;
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    const eye = this._v1.setFromMatrixPosition(cam.matrixWorld);
    const sky = w.skyAt ? w.skyAt(eye.x, eye.z) : 1;
    // ambient: hemisphere + environment, scaled by sky visibility where the player stands
    M.hemi.color.copy(L.hemi.color); M.hemi.groundColor.copy(L.hemi.groundColor);
    M.hemi.intensity = L.hemi.intensity * sky;
    M.hemi.position.set(0, 1, 0).transformDirection(inv);
    const env = this.game.scene && this.game.scene.environment;
    this.scene.environment = env || null;
    this.scene.environmentIntensity = (this.game.scene ? this.game.scene.environmentIntensity : 1) * sky;
    /* lookup must be rotated from camera space back to world space; three negates this Euler for PMREM targets */
    this._e.setFromQuaternion(cam.quaternion, 'XYZ');
    this.scene.environmentRotation.set(-this._e.x, -this._e.y, -this._e.z, 'XYZ');
    // directionals: moon + bounce, directions rotated into camera space
    const dirs = [L.moon, ...(L.bounce || [])];
    for (let i = 0; i < M.dirs.length; i++) {
      const src = dirs[i], dst = M.dirs[i];
      if (!src) { dst.intensity = 0; continue; }
      dst.color.copy(src.color); dst.intensity = src.intensity;
      this._v2.subVectors(src.position, src.target.position).normalize().transformDirection(inv);
      dst.position.copy(this._v2);
    }
    // two strongest local lights at the eye (spot cone attenuation evaluated here, on the CPU)
    const cands = this._cands; cands.length = 0;
    const consider = (li) => {
      const d = li.position.distanceTo(eye);
      let k = 1;
      if (li.isSpotLight) {
        this._v2.subVectors(li.target.position, li.position).normalize();
        const cosA = this._v2.dot(this._v1.copy(eye).sub(li.position).normalize());
        this._v1.setFromMatrixPosition(cam.matrixWorld);                     // restore eye
        const cOut = Math.cos(li.angle), cIn = Math.cos(li.angle * (1 - li.penumbra));
        const t = Math.min(1, Math.max(0, (cosA - cOut) / Math.max(cIn - cOut, 1e-4)));
        k = t * t * (3 - 2 * t);
      }
      let att = 1 / Math.max(Math.pow(d, li.decay), 0.01);
      if (li.distance > 0) att *= Math.pow(Math.max(0, 1 - Math.pow(d / li.distance, 4)), 2);
      const e = li.intensity * k * att;
      if (e > 1e-4) cands.push({ li, k, e });
    };
    for (const li of L.lampLights || []) consider(li);
    for (const li of L.farFill || []) consider(li);
    for (const li of L.fills || []) consider(li);
    cands.sort((a, b) => b.e - a.e);
    for (let i = 0; i < M.points.length; i++) {
      const c = cands[i], p = M.points[i];
      if (!c) { p.intensity = 0; continue; }
      p.color.copy(c.li.color);
      p.intensity = c.li.intensity * c.k;
      p.decay = c.li.decay; p.distance = c.li.distance;
      p.position.copy(c.li.position).applyMatrix4(inv);
    }
  }

  kick(amount) {
    this.recoilZ += feel.viewmodel.recoilKickZ * amount;
    this.recoilPitch += feel.viewmodel.recoilKickPitch * amount;
  }
}
