/* ============================================================
   feel.js - handling parameter hub (single source of truth)
   ------------------------------------------------------------
   Conventions:
     · every handling number lives only here; logic reads it each frame and never caches it at construction
     · batch 1 took the values the code actually used at the time, so behaviour did not change
     · wired:false marks a parameter that isn't hooked up yet (batches 2/3); the panel labels it
   Note: TUNING in data.js holds AI/identification parameters and by agreement stays there, not merged here.
   ============================================================ */

export const feel = {
  /* ---------------- Movement ---------------- */
  move: {
    walkSpeed: 3.1,          // base speed m/s (times armour factor)
    sprintMul: 1.55,         // sprint multiplier
    crouchMul: 0.52,         // crouch multiplier
    adsSpeedMul: 0.55,       // ADS movement multiplier
    adsGate: 0.5,            // ADS blend above which ADS speed applies
    sprintFwdGate: 0.1,      // sprint only with forward input
    staminaMin: 0.05,        // no sprint below this stamina
    staminaDrain: 0.22,      // sprint stamina drain /s
    staminaRegen: 0.35,      // stamina regen /s
    accelTime: 0,            // time to reach target speed s (0 = instant; wired in batch 2)
    decelTime: 0,            // time to stop after release s (0 = instant; wired in batch 2)
    intertiaGlide: 0,        // glide after release s (wired in batch 2)
    diagNormalize: true,     // diagonal normalisation (live)
    turnDamping: 0,          // yaw damping (deliberately not implemented, stays 0)
    airControl: 0,           // air control (no jump, stays 0)
  },
  /* ---------------- Jump (disabled this round; interface reserved) ---------------- */
  jump: {
    enabled: false,
    speed: 0, gravity: 0, airControl: 0,
    landingBufferTime: 0,    // landing buffer s
    landingSlowTime: 0,      // landing slow penalty s
    landingSlowMul: 1,       // speed multiplier after landing (1 = no penalty)
    sprintLandingMul: 1,     // extra penalty multiplier when landing from a sprint
    crouchLandingMul: 1,     // reduction multiplier when landing crouched
    landingShake: 0,         // landing camera dip m
  },
  /* ---------------- Camera ---------------- */
  camera: {
    fovDefault: 72,
    fovSprint: 82,
    adsFovOverride: 0,       // >0 overrides the weapon's own ADS FOV
    sensBase: 0.0022,        // look sensitivity rad/px
    adsSensMul: 0.45,        // sensitivity reduction while ADS
    headBobEnabled: true,
    bobAmpY: 0.028, bobAmpX: 0.022,
    bobSpeedBase: 7, bobSpeedPerMove: 5, bobSpeedIdle: 2,
    bobAdsDamp: 0.75,        // head bob damping while ADS
    swayAmpX: 0.016, swayAmpY: 0.012,
    swayAdsDamp: 0.7,
    sprintBobMul: 1.5,
    rollAmp: 0.012,          // camera roll while walking (rad)
  },
  /* ---------------- Weapon (global handling knobs) ---------------- */
  weapon: {
    recoilKickPitch: 0.16,   // vertical kick per shot
    recoilAdsMul: 0.65,      // recoil multiplier while ADS
    recoilJitterYaw: 0.06,   // horizontal jitter (relative to weapon recoil)
    recoilDecayPitch: 7,     // vertical recovery rate
    recoilDecayYaw: 6,       // horizontal recovery rate
    recoilPitchToAim: 2.2,   // rate recoil converts into pitch
    recoilYawToAim: 1.6,     // rate recoil converts into yaw
    recoilPatternEnabled: false,   // fixed recoil pattern (wired in batch 3)
    firstShotMul: 1,               // first-shot recoil multiplier (batch 3)
    burstAccum: 1,                 // burst accumulation (batch 3)
  },
  /* ---------------- Spread ---------------- */
  spread: {
    adsSpreadGate: 0.6,      // ADS value above which ADS spread is used
    moveSpreadMul: 1,        // movement spread multiplier
    sprintSpreadMul: 1.6,    // extra movement spread multiplier while sprinting
    recoilToSpread: 0.5,     // recoil → spread coefficient
    suppressionToSpread: 0.01,
    burstSpreadPerShot: 0,   // per-shot burst increment rad (wired in batch 3)
    spreadRecovery: 0,       // spread recovery /s (wired in batch 3)
    crouchSpreadMul: 1,      // crouch spread multiplier (wired in batch 2/3)
    jumpSpreadMul: 1,        // airborne spread multiplier (no jump, stays 1)
  },
  /* ---------------- Feedback ---------------- */
  feedback: {
    hitmarkerTime: 0.28,     // hitmarker hold s
    hitmarkerKillTime: 0.28,
    hitSoundVolume: 0.22,    // hit sound volume (own timbre in batch 3)
    hitStopTime: 0,          // hit stop s (wired in batch 3)
    damageNumberTime: 0,     // damage number hold s (wired in batch 3)
    shakeKick: 0.28,         // fire screen-shake strength
    shakeDecay: 7,           // shake decay rate
    shakeYaw: 0.06, shakeRoll: 0.05,
    muzzleFlashTime: 0.05,   // muzzle flash duration s
    shellEjectSpeed: 0,      // shell eject speed m/s (wired in batch 3)
    impactSparkScale: 1,     // impact spark size multiplier (1 = matches current code)
  },
  /* ---------------- Reload / switch / ADS transition ---------------- */
  reload: {
    switchFireCd: 0.35,      // no-fire time after switching s
    adsInSpeed: 7,           // ADS in rate (1/s)
    adsOutSpeed: 8,          // ADS out rate (1/s)
    reloadScale: 1,          // reload time scale (weapon value × this)
    interruptible: false,    // reload can be interrupted (wired in batch 3)
  },
  /* ---------------- First-person weapon pose (inertia carrier) ---------------- */
  viewmodel: {
    bobAmpX: 0.014, bobAmpY: 0.012,
    bobAdsDamp: 0.8,
    lagYaw: 0.55, lagPitch: 0.45, lagDamp: 12,
    recoilKickZ: 0.05, recoilKickPitch: 0.10,
    reloadDip: 0.16, reloadTilt: 0.25,
    sprintDrop: 0.10, sprintTilt: 0.42,
  },
  /* ---------------- Debug switches (not part of the feel itself) ---------------- */
  debug: {
    freezeAI: false,
    invincible: false,
    showCurves: false,
    selectedParam: 'move.walkSpeed',
    timeScaleOverride: 1,
  },
};

/* ============================================================
   Parameter table: the tuning panel builds its controls from this
   wired=false is labelled "not wired" on the panel
   ============================================================ */
export const FEEL_SCHEMA = [
  { group: 'move', label: 'Movement', items: [
    ['walkSpeed', 'Walk speed', 0, 12, 0.05, 'm/s'],
    ['sprintMul', 'Sprint multiplier', 1, 3, 0.01, 'x'],
    ['crouchMul', 'Crouch multiplier', 0.1, 1.5, 0.01, 'x'],
    ['adsSpeedMul', 'ADS speed multiplier', 0.1, 1.5, 0.01, 'x'],
    ['staminaDrain', 'Stamina drain', 0, 1, 0.01, '/s'],
    ['staminaRegen', 'Stamina regen', 0, 1, 0.01, '/s'],
    ['accelTime', 'Accel time', 0, 0.5, 0.005, 's', false],
    ['decelTime', 'Decel time', 0, 0.5, 0.005, 's', false],
    ['intertiaGlide', 'Release glide', 0, 0.5, 0.005, 's', false],
    ['diagNormalize', 'Normalise diagonals', 0, 1, 1, '', true, 'bool'],
  ]},
  { group: 'jump', label: 'Jump (disabled this build)', items: [
    ['enabled', 'Enable jump', 0, 1, 1, '', true, 'bool'],
    ['speed', 'Launch speed', 0, 12, 0.1, 'm/s', false],
    ['gravity', 'Gravity', 0, 40, 0.1, 'm/s2', false],
    ['landingBufferTime', 'Landing buffer', 0, 0.6, 0.01, 's', false],
    ['landingSlowTime', 'Landing slow time', 0, 1, 0.01, 's', false],
    ['landingSlowMul', 'Landing speed floor', 0, 1, 0.01, 'x', false],
    ['landingShake', 'Landing camera dip', 0, 0.5, 0.005, 'm', false],
  ]},
  { group: 'camera', label: 'Camera', items: [
    ['fovDefault', 'Default FOV', 50, 110, 1, 'deg'],
    ['fovSprint', 'Sprint FOV', 50, 120, 1, 'deg'],
    ['adsFovOverride', 'ADS FOV override (0 = weapon)', 0, 90, 1, 'deg'],
    ['sensBase', 'Look sensitivity', 0.0002, 0.01, 0.0001, 'rad/px'],
    ['adsSensMul', 'ADS sensitivity cut', 0, 0.9, 0.01, 'x'],
    ['headBobEnabled', 'Head bob', 0, 1, 1, '', true, 'bool'],
    ['bobAmpY', 'Head bob Y', 0, 0.12, 0.001, 'm'],
    ['bobAmpX', 'Head bob X', 0, 0.12, 0.001, 'm'],
    ['swayAmpX', 'Weapon sway X', 0, 0.1, 0.001, 'm'],
    ['swayAmpY', 'Weapon sway Y', 0, 0.1, 0.001, 'm'],
    ['bobSpeedBase', 'Bob rate base', 0, 20, 0.5, '/s'],
    ['bobSpeedPerMove', 'Bob rate per speed', 0, 20, 0.5, '/s'],
    ['rollAmp', 'Camera roll', 0, 0.1, 0.001, 'rad'],
  ]},
  { group: 'weapon', label: 'Recoil', items: [
    ['recoilKickPitch', 'Vertical kick', 0, 1, 0.005, 'x'],
    ['recoilAdsMul', 'ADS recoil multiplier', 0, 1.5, 0.01, 'x'],
    ['recoilJitterYaw', 'Horizontal jitter', 0, 0.5, 0.005, 'x'],
    ['recoilDecayPitch', 'Vertical recovery', 0, 30, 0.5, '/s'],
    ['recoilDecayYaw', 'Horizontal recovery', 0, 30, 0.5, '/s'],
    ['recoilPitchToAim', 'Recoil → pitch rate', 0, 10, 0.1, 'x'],
    ['recoilYawToAim', 'Recoil → yaw rate', 0, 10, 0.1, 'x'],
    ['recoilPatternEnabled', 'Fixed recoil pattern', 0, 1, 1, '', false, 'bool'],
    ['firstShotMul', 'First-shot multiplier', 0, 2, 0.01, 'x', false],
    ['burstAccum', 'Burst accumulation', 0, 3, 0.01, 'x', false],
  ]},
  { group: 'spread', label: 'Spread', items: [
    ['adsSpreadGate', 'ADS spread threshold', 0, 1, 0.05, 'x'],
    ['moveSpreadMul', 'Move spread multiplier', 0, 4, 0.05, 'x'],
    ['sprintSpreadMul', 'Sprint spread extra', 1, 4, 0.05, 'x'],
    ['recoilToSpread', 'Recoil → spread', 0, 3, 0.05, 'x'],
    ['suppressionToSpread', 'Suppression → spread', 0, 0.2, 0.001, 'x'],
    ['burstSpreadPerShot', 'Burst spread per shot', 0, 0.05, 0.0005, 'rad', false],
    ['spreadRecovery', 'Spread recovery', 0, 10, 0.05, '/s', false],
    ['crouchSpreadMul', 'Crouch spread multiplier', 0, 2, 0.05, 'x', false],
  ]},
  { group: 'feedback', label: 'Feedback', items: [
    ['hitmarkerTime', 'Hitmarker hold', 0, 1, 0.01, 's'],
    ['hitmarkerKillTime', 'Kill hitmarker hold', 0, 1, 0.01, 's'],
    ['hitSoundVolume', 'Hit sound volume', 0, 1, 0.01, 'x'],
    ['hitStopTime', 'Hit stop', 0, 0.2, 0.005, 's', false],
    ['damageNumberTime', 'Damage number hold', 0, 2, 0.05, 's', false],
    ['shakeKick', 'Fire shake', 0, 2, 0.01, 'x'],
    ['shakeDecay', 'Shake decay', 0, 30, 0.5, '/s'],
    ['muzzleFlashTime', 'Muzzle flash time', 0.01, 0.5, 0.005, 's'],
    ['shellEjectSpeed', 'Shell eject speed', 0, 15, 0.1, 'm/s', false],
    ['impactSparkScale', 'Impact spark size', 0.1, 3, 0.05, 'x'],
  ]},
  { group: 'reload', label: 'Reload / switch / ADS', items: [
    ['switchFireCd', 'Switch time', 0.1, 1.5, 0.01, 's'],
    ['adsInSpeed', 'ADS in rate', 1, 30, 0.5, '/s'],
    ['adsOutSpeed', 'ADS out rate', 1, 30, 0.5, '/s'],
    ['reloadScale', 'Reload time scale', 0.2, 3, 0.05, 'x', false],
    ['interruptible', 'Reload cancellable', 0, 1, 1, '', false, 'bool'],
  ]},
  { group: 'viewmodel', label: 'Viewmodel pose', items: [
    ['bobAmpX', 'Weapon bob X', 0, 0.1, 0.001, 'm'],
    ['bobAmpY', 'Weapon bob Y', 0, 0.1, 0.001, 'm'],
    ['lagYaw', 'Turn drag Y', 0, 2, 0.01, 'x'],
    ['lagPitch', 'Turn drag X', 0, 2, 0.01, 'x'],
    ['recoilKickZ', 'Recoil push-back', 0, 0.3, 0.005, 'm'],
    ['recoilKickPitch', 'Recoil muzzle rise', 0, 0.5, 0.005, 'rad'],
    ['sprintDrop', 'Sprint lower', 0, 0.4, 0.005, 'm'],
    ['sprintTilt', 'Sprint tilt', 0, 1.2, 0.01, 'rad'],
  ]},
];

/* Preset slots: A is pinned to the "original (pre-change)" baseline for A/B comparison */
export const FEEL_PRESETS = { A: null, B: null, C: null };
export const PRESET_LABELS = { A: 'Original (pre-change)', B: 'Preset B (empty)', C: 'Preset C (empty)' };

/* ============================================================
   Live telemetry: ring buffers for the four curves (preallocated, reused per frame, zero GC)
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

/* Exposed globally: the tuning panel and the console can read and write it directly */
if (typeof window !== 'undefined') window.__feel = feel;
if (typeof window !== 'undefined') window.__feelSchema = FEEL_SCHEMA;   // for the tuning panel / test cross-checks
