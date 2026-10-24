/* ============================================================
   attract.js — the live world behind the title screen
   ------------------------------------------------------------
   Lessons from the treasure-hunting adventures that do this best (Uncharted, Sea of Thieves, Indiana Jones and
   the Great Circle): the title sits over the actual game world, not a picture of it; the camera drifts slowly with
   a little hand-held life; and pressing start flows into play without a cut. Here the port is built once on boot,
   a camera loops slowly through the fog over the yard, and Deploy adopts this exact world (see Game.deploy) while
   the camera glides from the title view down into the team lead's eyes.

   The path is a closed Catmull-Rom loop through open air: over the central lane, under the yard gantry's beam,
   over the dispatch roof and back along the east lane, every point clear of container stacks (≤5.2 m), lamp
   poles and the gantry spreader. One lap takes ~150 s (≈1.7 m/s). Under prefers-reduced-motion the camera holds a
   single composed shot instead.
   ============================================================ */
import * as THREE from 'three';

const PATH = [
  [2, 6.5, 40], [0, 6.0, 12], [-3, 7.5, -18], [-2, 9, -40],
  [8, 12, -56], [22, 10.5, -40], [18, 7, -8], [12, 7, 22],
];
const LAP_SECONDS = 150;
export const ATTRACT_FOV = 58;

export class AttractCamera {
  constructor() {
    this.curve = new THREE.CatmullRomCurve3(PATH.map((p) => new THREE.Vector3(...p)), true, 'centripetal');
    this.t = 0;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  /* realTime: seconds since attract started (menus are not simulation; nothing here feeds game state) */
  apply(camera, dt, reducedMotion) {
    if (!reducedMotion) this.t += dt;
    /* reduced motion: one composed frame over the central lane, looking up the yard towards the gantry */
    const u = reducedMotion ? 0.2 : (this.t / LAP_SECONDS) % 1;
    const p = this.curve.getPointAt(u, this._a);
    const ahead = this.curve.getPointAt((u + 0.035) % 1, this._b);
    ahead.y -= 1.6;                                         // look slightly down into the yard
    if (!reducedMotion) {                                   // hand-held: two slow, incommensurate sways
      const s = this.t;
      p.x += Math.sin(s * 0.31) * 0.12; p.y += Math.sin(s * 0.23 + 1.3) * 0.08;
      ahead.x += Math.sin(s * 0.17 + 0.4) * 0.35; ahead.y += Math.sin(s * 0.13) * 0.2;
    }
    camera.position.copy(p);
    camera.up.set(0, 1, 0);
    camera.lookAt(ahead);
    if (camera.fov !== ATTRACT_FOV) { camera.fov = ATTRACT_FOV; camera.updateProjectionMatrix(); }
  }
}
