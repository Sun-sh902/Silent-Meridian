/* ============================================================
   tools/poses.mjs — the five named camera poses shared by shots-fixed.mjs and render-time.mjs
   ============================================================ */
/* ---------------- Fixed poses ----------------
   yaw: 0 = facing -Z (north, towards the quay), +π/2 = facing -X (west). clock is in-game seconds. */
export const POSES = [
  { name: 'gate-approach', pos: [0, 43.5], yaw: 0, pitch: -0.03, fov: 72, clock: 23 * 3600 + 41 * 60, steps: 40 },
  { name: 'yard-center', pos: [0, -14], yaw: 0, pitch: -0.02, fov: 72, clock: 23 * 3600 + 47 * 60, steps: 40 },
  { name: 'yard-lamp', pos: [19, -10], yaw: 0.18, pitch: -0.10, fov: 72, clock: 23 * 3600 + 49 * 60, steps: 40 },
  { name: 'container-row', pos: [-14.5, -44], yaw: 3.05, pitch: -0.03, fov: 72, clock: 23 * 3600 + 52 * 60, steps: 40 },
  { name: 'dock-edge', pos: [-4, -61.5], yaw: -1.45, pitch: -0.05, fov: 72, clock: 23 * 3600 + 58 * 60, steps: 40 },
];
