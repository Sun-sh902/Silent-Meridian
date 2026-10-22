/* ============================================================
   feel.js - feel parameter hub (single source of truth)
   ------------------------------------------------------------
   Conventions:
     · All feel numbers appear only here; logic code reads them every frame and never caches them at construction time
     · Batch 1 ships with the "current code's actual values", guaranteeing zero behavior change
     · wired:false means the parameter is not wired yet (batch 2/3); the panel labels it
   Note: TUNING in data.js holds AI/identification parameters and by convention stays as-is, not merged into this file.
   ============================================================ */

export const feel = {
  /* ---------------- Movement ---------------- */
  move: {
    walkSpeed: 3.1,          // base speed m/s (then multiplied by armor factor)
    sprintMul: 1.55,         // sprint multiplier
    crouchMul: 0.52,         // crouch multiplier
    adsSpeedMul: 0.55,       // ADS movement multiplier
    adsGate: 0.5,            // ADS movement speed applies only above this blend value
    sprintFwdGate: 0.1,      // sprint only with forward input
    staminaMin: 0.05,        // cannot sprint below this stamina
    staminaDrain: 0.22,      // sprint stamina drain /s
    staminaRegen: 0.35,      // stamina recovery /s
    accelTime: 0,            // time to reach target speed s (0 = instant, wired in batch 2)
    decelTime: 0,            // time to stop after release s (0 = instant, wired in batch 2)
    intertiaGlide: 0,        // glide duration after release s (wired in batch 2)
    diagNormalize: true,     // diagonal normalization (active)
    turnDamping: 0,          // yaw damping (deliberately not implemented, stays 0)
    airControl: 0,           // air control (no jumping, stays 0)
  },
  /* ---------------- Jump (disabled this round; hooks reserved) ---------------- */
  jump: {
    enabled: false,
    speed: 0, gravity: 0, airControl: 0,
    landingBufferTime: 0,    // landing buffer duration s
    landingSlowTime: 0,      // landing slowdown penalty duration s
    landingSlowMul: 1,       // post-landing speed multiplier (1 = no penalty)
    sprintLandingMul: 1,     // extra penalty multiplier for sprint landings
    crouchLandingMul: 1,     // reduction multiplier for crouched landings
    landingShake: 0,         // landing camera dip m
  },
  /* ---------------- Camera ---------------- */
  camera: {
    fovDefault: 72,
    fovSprint: 82,
    adsFovOverride: 0,       // >0 overrides the weapon's own ADS field of view
    sensBase: 0.0022,        // turn sensitivity rad/px
    adsSensMul: 0.45,        // sensitivity reduction while in ADS
    headBobEnabled: true,
    bobAmpY: 0.028, bobAmpX: 0.022,
    bobSpeedBase: 7, bobSpeedPerMove: 5, bobSpeedIdle: 2,
    bobAdsDamp: 0.75,        // head-bob damping while aiming
    swayAmpX: 0.016, swayAmpY: 0.012,
    swayAdsDamp: 0.7,
    sprintBobMul: 1.5,
    rollAmp: 0.012,          // camera roll while walking (rad)
  },
  /* ---------------- Weapon (global feel knobs) ---------------- */
  weapon: {
    recoilKickPitch: 0.16,   // vertical kick per shot
    recoilAdsMul: 0.65,      // recoil multiplier while aiming
    recoilJitterYaw: 0.06,   // horizontal jitter (relative to weapon recoil)
    recoilDecayPitch: 7,     // vertical recovery speed
    recoilDecayYaw: 6,       // horizontal recovery speed
    recoilPitchToAim: 2.2,   // rate of recoil-to-pitch conversion
    recoilYawToAim: 1.6,     // rate of recoil-to-yaw conversion
    recoilPatternEnabled: false,   // deterministic recoil pattern (wired in batch 3)
    firstShotMul: 1,               // first-shot recoil multiplier (batch 3)
    burstAccum: 1,                 // burst accumulation factor (batch 3)
  },
  /* ---------------- Spread ---------------- */
  spread: {
    adsSpreadGate: 0.6,      // above this ADS value, use ADS spread
    moveSpreadMul: 1,        // moving spread multiplier
    sprintSpreadMul: 1.6,    // extra moving-spread multiplier while sprinting
    recoilToSpread: 0.5,     // recoil-to-spread coefficient
    suppressionToSpread: 0.01,
    burstSpreadPerShot: 0,   // per-shot burst increment rad (wired in batch 3)
    spreadRecovery: 0,       // spread recovery speed /s (wired in batch 3)
    crouchSpreadMul: 1,      // crouched spread multiplier (wired in batch 2/3)
    jumpSpreadMul: 1,        // airborne spread multiplier (no jumping, stays 1)
  },
  /* ---------------- Feedback ---------------- */
  feedback: {
    hitmarkerTime: 0.28,     // hitmarker duration s
    hitmarkerKillTime: 0.28,
    hitSoundVolume: 0.22,    // hit sound volume (separate timbre in batch 3)
    hitStopTime: 0,          // hit-stop s (wired in batch 3)
    damageNumberTime: 0,     // damage-number duration s (wired in batch 3)
    shakeKick: 0.28,         // firing screen-shake strength factor
    shakeDecay: 7,           // shake decay speed
    shakeYaw: 0.06, shakeRoll: 0.05,
    muzzleFlashTime: 0.05,   // muzzle-flash duration s
    shellEjectSpeed: 0,      // shell ejection speed m/s (wired in batch 3)
    impactSparkScale: 1,     // impact spark size multiplier (1 = same as current code)
  },
  /* ---------------- Reload / weapon switch / ADS transition ---------------- */
  reload: {
    switchFireCd: 0.35,      // no-fire duration after switching s
    adsInSpeed: 7,           // ADS entry rate (1/s)
    adsOutSpeed: 8,          // ADS exit rate (1/s)
    reloadScale: 1,          // reload duration scale (weapon value × this factor)
    interruptible: false,    // whether reloads can be interrupted (wired in batch 3)
  },
  /* ---------------- First-person weapon pose (inertial carrier) ---------------- */
  viewmodel: {
    bobAmpX: 0.014, bobAmpY: 0.012,
    bobAdsDamp: 0.8,
    lagYaw: 0.55, lagPitch: 0.45, lagDamp: 12,
    recoilKickZ: 0.05, recoilKickPitch: 0.10,
    reloadDip: 0.16, reloadTilt: 0.25,
    sprintDrop: 0.10, sprintTilt: 0.42,
  },
  /* ---------------- Debug toggles (not part of feel itself) ---------------- */
  debug: {
    freezeAI: false,
    invincible: false,
    showCurves: false,
    selectedParam: 'move.walkSpeed',
    timeScaleOverride: 1,
  },
};

/* ============================================================
   Parameter table: drives automatic control generation in the tuning panel
   wired=false is labeled "not wired" in the panel
   ============================================================ */
export const FEEL_SCHEMA = [
  { group: 'move', label: 'MOVEMENT', items: [
    ['walkSpeed', 'Walk speed', 0, 12, 0.05, 'm/s'],
    ['sprintMul', 'Sprint multiplier', 1, 3, 0.01, 'x'],
    ['crouchMul', 'Crouch multiplier', 0.1, 1.5, 0.01, 'x'],
    ['adsSpeedMul', 'ADS speed multiplier', 0.1, 1.5, 0.01, 'x'],
    ['staminaDrain', 'Stamina drain', 0, 1, 0.01, '/s'],
    ['staminaRegen', 'Stamina recovery', 0, 1, 0.01, '/s'],
    ['accelTime', 'Acceleration time', 0, 0.5, 0.005, 's', false],
    ['decelTime', 'Deceleration time', 0, 0.5, 0.005, 's', false],
    ['intertiaGlide', 'Release glide', 0, 0.5, 0.005, 's', false],
    ['diagNormalize', 'Diagonal normalization', 0, 1, 1, '', true, 'bool'],
  ]},
  { group: 'jump', label: 'JUMP (disabled this round)', items: [
    ['enabled', 'Enable jump', 0, 1, 1, '', true, 'bool'],
    ['speed', 'Initial speed', 0, 12, 0.1, 'm/s', false],
    ['gravity', 'Gravity', 0, 40, 0.1, 'm/s2', false],
    ['landingBufferTime', 'Landing buffer', 0, 0.6, 0.01, 's', false],
    ['landingSlowTime', 'Landing slowdown', 0, 1, 0.01, 's', false],
    ['landingSlowMul', 'Landing speed multiplier', 0, 1, 0.01, 'x', false],
    ['landingShake', 'Landing camera dip', 0, 0.5, 0.005, 'm', false],
  ]},
  { group: 'camera', label: 'CAMERA', items: [
    ['fovDefault', 'Default field of view', 50, 110, 1, 'deg'],
    ['fovSprint', 'Sprint field of view', 50, 120, 1, 'deg'],
    ['adsFovOverride', 'ADS FOV override (0 = weapon value)', 0, 90, 1, 'deg'],
    ['sensBase', 'Turn sensitivity', 0.0002, 0.01, 0.0001, 'rad/px'],
    ['adsSensMul', 'ADS sensitivity reduction', 0, 0.9, 0.01, 'x'],
    ['headBobEnabled', 'Head bob', 0, 1, 1, '', true, 'bool'],
    ['bobAmpY', 'Head bob Y', 0, 0.12, 0.001, 'm'],
    ['bobAmpX', 'Head bob X', 0, 0.12, 0.001, 'm'],
    ['swayAmpX', 'Weapon sway X', 0, 0.1, 0.001, 'm'],
    ['swayAmpY', 'Weapon sway Y', 0, 0.1, 0.001, 'm'],
    ['bobSpeedBase', 'Bob rate base', 0, 20, 0.5, '/s'],
    ['bobSpeedPerMove', 'Bob rate per speed', 0, 20, 0.5, '/s'],
    ['rollAmp', 'Camera roll', 0, 0.1, 0.001, 'rad'],
  ]},
  { group: 'weapon', label: 'RECOIL', items: [
    ['recoilKickPitch', 'Vertical kick', 0, 1, 0.005, 'x'],
    ['recoilAdsMul', 'ADS recoil multiplier', 0, 1.5, 0.01, 'x'],
    ['recoilJitterYaw', 'Horizontal jitter', 0, 0.5, 0.005, 'x'],
    ['recoilDecayPitch', 'Vertical recovery', 0, 30, 0.5, '/s'],
    ['recoilDecayYaw', 'Horizontal recovery', 0, 30, 0.5, '/s'],
    ['recoilPitchToAim', 'Recoil→pitch rate', 0, 10, 0.1, 'x'],
    ['recoilYawToAim', 'Recoil→yaw rate', 0, 10, 0.1, 'x'],
    ['recoilPatternEnabled', 'Recoil pattern', 0, 1, 1, '', false, 'bool'],
    ['firstShotMul', 'First-shot recoil multiplier', 0, 2, 0.01, 'x', false],
    ['burstAccum', 'Burst accumulation', 0, 3, 0.01, 'x', false],
  ]},
  { group: 'spread', label: 'SPREAD', items: [
    ['adsSpreadGate', 'ADS spread threshold', 0, 1, 0.05, 'x'],
    ['moveSpreadMul', 'Moving spread multiplier', 0, 4, 0.05, 'x'],
    ['sprintSpreadMul', 'Sprint spread multiplier', 1, 4, 0.05, 'x'],
    ['recoilToSpread', 'Recoil→spread coefficient', 0, 3, 0.05, 'x'],
    ['suppressionToSpread', 'Suppression→spread coefficient', 0, 0.2, 0.001, 'x'],
    ['burstSpreadPerShot', 'Burst spread per shot', 0, 0.05, 0.0005, 'rad', false],
    ['spreadRecovery', 'Spread recovery', 0, 10, 0.05, '/s', false],
    ['crouchSpreadMul', 'Crouched spread multiplier', 0, 2, 0.05, 'x', false],
  ]},
  { group: 'feedback', label: 'FEEDBACK', items: [
    ['hitmarkerTime', 'Hitmarker duration', 0, 1, 0.01, 's'],
    ['hitmarkerKillTime', 'Kill hitmarker duration', 0, 1, 0.01, 's'],
    ['hitSoundVolume', 'Hit sound volume', 0, 1, 0.01, 'x'],
    ['hitStopTime', 'Hit-stop', 0, 0.2, 0.005, 's', false],
    ['damageNumberTime', 'Damage number duration', 0, 2, 0.05, 's', false],
    ['shakeKick', 'Firing shake strength', 0, 2, 0.01, 'x'],
    ['shakeDecay', 'Shake decay', 0, 30, 0.5, '/s'],
    ['muzzleFlashTime', 'Muzzle flash duration', 0.01, 0.5, 0.005, 's'],
    ['shellEjectSpeed', 'Shell ejection speed', 0, 15, 0.1, 'm/s', false],
    ['impactSparkScale', 'Impact spark size', 0.1, 3, 0.05, 'x'],
  ]},
  { group: 'reload', label: 'RELOAD / SWITCH / ADS', items: [
    ['switchFireCd', 'Weapon switch time', 0.1, 1.5, 0.01, 's'],
    ['adsInSpeed', 'ADS entry rate', 1, 30, 0.5, '/s'],
    ['adsOutSpeed', 'ADS exit rate', 1, 30, 0.5, '/s'],
    ['reloadScale', 'Reload duration scale', 0.2, 3, 0.05, 'x', false],
    ['interruptible', 'Interruptible reload', 0, 1, 1, '', false, 'bool'],
  ]},
  { group: 'viewmodel', label: 'VIEWMODEL', items: [
    ['bobAmpX', 'Weapon bob X', 0, 0.1, 0.001, 'm'],
    ['bobAmpY', 'Weapon bob Y', 0, 0.1, 0.001, 'm'],
    ['lagYaw', 'Turn drag Y', 0, 2, 0.01, 'x'],
    ['lagPitch', 'Turn drag X', 0, 2, 0.01, 'x'],
    ['recoilKickZ', 'Recoil pushback', 0, 0.3, 0.005, 'm'],
    ['recoilKickPitch', 'Recoil muzzle rise', 0, 0.5, 0.005, 'rad'],
    ['sprintDrop', 'Sprint weapon drop', 0, 0.4, 0.005, 'm'],
    ['sprintTilt', 'Sprint tilt', 0, 1.2, 0.01, 'rad'],
  ]},
];

/* Preset slots: A is fixed to the "Original (pre-change)" baseline for A/B comparison */
export const FEEL_PRESETS = { A: null, B: null, C: null };
export const PRESET_LABELS = { A: 'Original (pre-change)', B: 'Preset B (empty)', C: 'Preset C (empty)' };

/* ============================================================
   Live telemetry: ring buffers for four curves (preallocated, reused every frame, zero GC)
   ============================================================ */
export const telemetry = {
  N: 180, i: 0, count: 0,
  speed: new Float32Array(180),
  accel: new Float32Array(180),
  recoil: new Float32Array(180),
  spread: new Float32Array(180),
  cur: { speed: 0, accel: 0, recoil: 0, spread: 0 },
  max: { speed: 0, accel: 0, recoil: 0, spread: 0 },
  _lastSpeed: 0,
  push(dt, speed, recoilPitch, spread) {
    const accel = dt > 0 ? (speed - this._lastSpeed) / dt : 0;
    this._lastSpeed = speed;
    const k = this.i;
    this.speed[k] = speed; this.accel[k] = accel;
    this.recoil[k] = recoilPitch; this.spread[k] = spread;
    this.cur.speed = speed; this.cur.accel = accel;
    this.cur.recoil = recoilPitch; this.cur.spread = spread;
    if (speed > this.max.speed) this.max.speed = speed;
    if (Math.abs(accel) > this.max.accel) this.max.accel = Math.abs(accel);
    if (Math.abs(recoilPitch) > this.max.recoil) this.max.recoil = Math.abs(recoilPitch);
    if (spread > this.max.spread) this.max.spread = spread;
    this.i = (k + 1) % this.N;
    this.count++;
  },
  reset() {
    this.i = 0; this.count = 0; this._lastSpeed = 0;
    this.speed.fill(0); this.accel.fill(0); this.recoil.fill(0); this.spread.fill(0);
    this.cur.speed = this.cur.accel = this.cur.recoil = this.cur.spread = 0;
    this.max.speed = this.max.accel = this.max.recoil = this.max.spread = 0;
  },
};

export function snapshotFeel() { return JSON.parse(JSON.stringify(feel)); }
export function applyFeel(obj) {
  for (const g of Object.keys(obj)) {
    if (!feel[g]) continue;
    for (const k of Object.keys(obj[g])) feel[g][k] = obj[g][k];
  }
}
export function exportFeelJSON() { return JSON.stringify(feel, null, 2); }

/* Exposed globally: the tuning panel and console can read/write directly */
if (typeof window !== 'undefined') window.__feel = feel;
if (typeof window !== 'undefined') window.__feelSchema = FEEL_SCHEMA;   // for tuning-panel/test reconciliation
