/* ============================================================
   feel.js - 手感参数中枢（唯一真源）
   ------------------------------------------------------------
   约定：
     · 所有手感数字只在这里出现，逻辑代码逐帧读取，不在构造期缓存
     · 第 1 批交付时全部取「当前代码的实际值」，保证行为零变化
     · wired:false 表示该参数尚未接线（第 2/3 批实现），面板会标注
   注意：data.js 里的 TUNING 是 AI/识别参数，按约定保持原样，不并入本文件。
   ============================================================ */

export const feel = {
  /* ---------------- 移动 ---------------- */
  move: {
    walkSpeed: 3.1,          // 基准速度 m/s（再乘护甲系数）
    sprintMul: 1.55,         // 疾跑倍率
    crouchMul: 0.52,         // 蹲行倍率
    adsSpeedMul: 0.55,       // 举枪移动倍率
    adsGate: 0.5,            // 超过该 ADS 混合值才套用举枪速度
    sprintFwdGate: 0.1,      // 仅有前向输入时才可疾跑
    staminaMin: 0.05,        // 低于该耐力不可疾跑
    staminaDrain: 0.22,      // 疾跑耐力消耗 /s
    staminaRegen: 0.35,      // 耐力恢复 /s
    accelTime: 0,            // 达到目标速度所需时间 s（0 = 瞬时，第 2 批接线）
    decelTime: 0,            // 松手后停下所需时间 s（0 = 瞬时，第 2 批接线）
    intertiaGlide: 0,        // 松手滑行时长 s（第 2 批接线）
    diagNormalize: true,     // 斜向归一化（已生效）
    turnDamping: 0,          // yaw 阻尼（按约定不做，保持 0）
    airControl: 0,           // 滞空操控（无跳跃，保持 0）
  },
  /* ---------------- 跳跃（本轮禁用，接口预留） ---------------- */
  jump: {
    enabled: false,
    speed: 0, gravity: 0, airControl: 0,
    landingBufferTime: 0,    // 落地缓冲时长 s
    landingSlowTime: 0,      // 落地减速惩罚时长 s
    landingSlowMul: 1,       // 落地后的速度倍率（1 = 无惩罚）
    sprintLandingMul: 1,     // 疾跑落地的额外惩罚倍率
    crouchLandingMul: 1,     // 蹲姿落地的减免倍率
    landingShake: 0,         // 落地镜头下沉幅度 m
  },
  /* ---------------- 相机 ---------------- */
  camera: {
    fovDefault: 72,
    fovSprint: 82,
    adsFovOverride: 0,       // >0 时覆盖武器自带 ADS 视场角
    sensBase: 0.0022,        // 转向灵敏度 rad/px
    adsSensMul: 0.45,        // ADS 时灵敏度下降比例
    headBobEnabled: true,
    bobAmpY: 0.028, bobAmpX: 0.022,
    bobSpeedBase: 7, bobSpeedPerMove: 5, bobSpeedIdle: 2,
    bobAdsDamp: 0.75,        // 举枪时头部晃动衰减
    swayAmpX: 0.016, swayAmpY: 0.012,
    swayAdsDamp: 0.7,
    sprintBobMul: 1.5,
    rollAmp: 0.012,          // 行走时的相机侧倾（rad）
  },
  /* ---------------- 武器（全局手感旋钮） ---------------- */
  weapon: {
    recoilKickPitch: 0.16,   // 每发垂直上跳系数
    recoilAdsMul: 0.65,      // 举枪时后坐倍率
    recoilJitterYaw: 0.06,   // 水平抖动幅度（相对武器后坐值）
    recoilDecayPitch: 7,     // 垂直回落速度
    recoilDecayYaw: 6,       // 水平回落速度
    recoilPitchToAim: 2.2,   // 后坐转化为俯仰的速率
    recoilYawToAim: 1.6,     // 后坐转化为偏航的速率
    recoilPatternEnabled: false,   // 规律弹道表（第 3 批接线）
    firstShotMul: 1,               // 首发后坐倍率（第 3 批）
    burstAccum: 1,                 // 连发累积系数（第 3 批）
  },
  /* ---------------- 扩散 ---------------- */
  spread: {
    adsSpreadGate: 0.6,      // 超过该 ADS 值改用 ADS 扩散
    moveSpreadMul: 1,        // 移动扩散倍率
    sprintSpreadMul: 1.6,    // 疾跑时移动扩散额外倍率
    recoilToSpread: 0.5,     // 后坐转化为扩散的系数
    suppressionToSpread: 0.01,
    burstSpreadPerShot: 0,   // 连发逐发增量 rad（第 3 批接线）
    spreadRecovery: 0,       // 扩散收缩速度 /s（第 3 批接线）
    crouchSpreadMul: 1,      // 蹲姿扩散倍率（第 2/3 批接线）
    jumpSpreadMul: 1,        // 滞空扩散倍率（无跳跃，保持 1）
  },
  /* ---------------- 反馈 ---------------- */
  feedback: {
    hitmarkerTime: 0.28,     // hitmarker 停留 s
    hitmarkerKillTime: 0.28,
    hitSoundVolume: 0.22,    // 命中音效音量（第 3 批改为独立音色）
    hitStopTime: 0,          // 受击顿帧 s（第 3 批接线）
    damageNumberTime: 0,     // 伤害数字停留 s（第 3 批接线）
    shakeKick: 0.28,         // 开火屏幕震动强度系数
    shakeDecay: 7,           // 震动衰减速度
    shakeYaw: 0.06, shakeRoll: 0.05,
    muzzleFlashTime: 0.05,   // 枪口闪光持续 s
    shellEjectSpeed: 0,      // 弹壳抛出速度 m/s（第 3 批接线）
    impactSparkScale: 1,     // 弹着火花尺寸倍率（1 = 与当前代码一致）
  },
  /* ---------------- 换弹 / 切枪 / ADS 过渡 ---------------- */
  reload: {
    switchFireCd: 0.35,      // 切枪后不可开火时长 s
    adsInSpeed: 7,           // ADS 进入速率（1/s）
    adsOutSpeed: 8,          // ADS 退出速率（1/s）
    reloadScale: 1,          // 换弹时长缩放（武器自带值 x 本系数）
    interruptible: false,    // 换弹是否可被打断（第 3 批接线）
  },
  /* ---------------- 第一人称武器姿态（惯性载体） ---------------- */
  viewmodel: {
    bobAmpX: 0.014, bobAmpY: 0.012,
    bobAdsDamp: 0.8,
    lagYaw: 0.55, lagPitch: 0.45, lagDamp: 12,
    recoilKickZ: 0.05, recoilKickPitch: 0.10,
    reloadDip: 0.16, reloadTilt: 0.25,
    sprintDrop: 0.10, sprintTilt: 0.42,
  },
  /* ---------------- 调试开关（不属于手感本身） ---------------- */
  debug: {
    freezeAI: false,
    invincible: false,
    showCurves: false,
    selectedParam: 'move.walkSpeed',
    timeScaleOverride: 1,
  },
};

/* ============================================================
   参数表：供调参面板自动生成控件
   wired=false 会在面板上标注「未接线」
   ============================================================ */
export const FEEL_SCHEMA = [
  { group: 'move', label: '移动 MOVE', items: [
    ['walkSpeed', '行走速度', 0, 12, 0.05, 'm/s'],
    ['sprintMul', '疾跑倍率', 1, 3, 0.01, 'x'],
    ['crouchMul', '蹲行倍率', 0.1, 1.5, 0.01, 'x'],
    ['adsSpeedMul', '举枪速度倍率', 0.1, 1.5, 0.01, 'x'],
    ['staminaDrain', '耐力消耗', 0, 1, 0.01, '/s'],
    ['staminaRegen', '耐力恢复', 0, 1, 0.01, '/s'],
    ['accelTime', '加速时间', 0, 0.5, 0.005, 's', false],
    ['decelTime', '减速时间', 0, 0.5, 0.005, 's', false],
    ['intertiaGlide', '松手滑行', 0, 0.5, 0.005, 's', false],
    ['diagNormalize', '斜向归一化', 0, 1, 1, '', true, 'bool'],
  ]},
  { group: 'jump', label: '跳跃 JUMP（本轮禁用）', items: [
    ['enabled', '启用跳跃', 0, 1, 1, '', true, 'bool'],
    ['speed', '初速', 0, 12, 0.1, 'm/s', false],
    ['gravity', '重力', 0, 40, 0.1, 'm/s2', false],
    ['landingBufferTime', '落地缓冲', 0, 0.6, 0.01, 's', false],
    ['landingSlowTime', '落地减速时长', 0, 1, 0.01, 's', false],
    ['landingSlowMul', '落地下限速度倍率', 0, 1, 0.01, 'x', false],
    ['landingShake', '落地镜头下沉', 0, 0.5, 0.005, 'm', false],
  ]},
  { group: 'camera', label: '相机 CAMERA', items: [
    ['fovDefault', '默认视场角', 50, 110, 1, 'deg'],
    ['fovSprint', '疾跑视场角', 50, 120, 1, 'deg'],
    ['adsFovOverride', 'ADS 视场角覆盖(0=用武器值)', 0, 90, 1, 'deg'],
    ['sensBase', '转向灵敏度', 0.0002, 0.01, 0.0001, 'rad/px'],
    ['adsSensMul', 'ADS 灵敏度降幅', 0, 0.9, 0.01, 'x'],
    ['headBobEnabled', '头部晃动开关', 0, 1, 1, '', true, 'bool'],
    ['bobAmpY', '头部晃动 Y', 0, 0.12, 0.001, 'm'],
    ['bobAmpX', '头部晃动 X', 0, 0.12, 0.001, 'm'],
    ['swayAmpX', '武器摆动 X', 0, 0.1, 0.001, 'm'],
    ['swayAmpY', '武器摆动 Y', 0, 0.1, 0.001, 'm'],
    ['bobSpeedBase', '晃动节奏基准', 0, 20, 0.5, '/s'],
    ['bobSpeedPerMove', '晃动节奏随速度', 0, 20, 0.5, '/s'],
    ['rollAmp', '相机侧倾', 0, 0.1, 0.001, 'rad'],
  ]},
  { group: 'weapon', label: '后坐力 RECOIL', items: [
    ['recoilKickPitch', '垂直上跳系数', 0, 1, 0.005, 'x'],
    ['recoilAdsMul', '举枪后坐倍率', 0, 1.5, 0.01, 'x'],
    ['recoilJitterYaw', '水平抖动幅度', 0, 0.5, 0.005, 'x'],
    ['recoilDecayPitch', '垂直回落速度', 0, 30, 0.5, '/s'],
    ['recoilDecayYaw', '水平回落速度', 0, 30, 0.5, '/s'],
    ['recoilPitchToAim', '后坐→俯仰速率', 0, 10, 0.1, 'x'],
    ['recoilYawToAim', '后坐→偏航速率', 0, 10, 0.1, 'x'],
    ['recoilPatternEnabled', '规律弹道表', 0, 1, 1, '', false, 'bool'],
    ['firstShotMul', '首发后坐倍率', 0, 2, 0.01, 'x', false],
    ['burstAccum', '连发累积系数', 0, 3, 0.01, 'x', false],
  ]},
  { group: 'spread', label: '扩散 SPREAD', items: [
    ['adsSpreadGate', 'ADS 扩散切换阈值', 0, 1, 0.05, 'x'],
    ['moveSpreadMul', '移动扩散倍率', 0, 4, 0.05, 'x'],
    ['sprintSpreadMul', '疾跑扩散额外倍率', 1, 4, 0.05, 'x'],
    ['recoilToSpread', '后坐→扩散系数', 0, 3, 0.05, 'x'],
    ['suppressionToSpread', '压制→扩散系数', 0, 0.2, 0.001, 'x'],
    ['burstSpreadPerShot', '连发逐发增量', 0, 0.05, 0.0005, 'rad', false],
    ['spreadRecovery', '扩散收缩速度', 0, 10, 0.05, '/s', false],
    ['crouchSpreadMul', '蹲姿扩散倍率', 0, 2, 0.05, 'x', false],
  ]},
  { group: 'feedback', label: '反馈 FEEDBACK', items: [
    ['hitmarkerTime', 'hitmarker 停留', 0, 1, 0.01, 's'],
    ['hitmarkerKillTime', '击倒 hitmarker 停留', 0, 1, 0.01, 's'],
    ['hitSoundVolume', '命中音效音量', 0, 1, 0.01, 'x'],
    ['hitStopTime', '受击顿帧', 0, 0.2, 0.005, 's', false],
    ['damageNumberTime', '伤害数字停留', 0, 2, 0.05, 's', false],
    ['shakeKick', '开火震动强度', 0, 2, 0.01, 'x'],
    ['shakeDecay', '震动衰减', 0, 30, 0.5, '/s'],
    ['muzzleFlashTime', '枪口闪光时长', 0.01, 0.5, 0.005, 's'],
    ['shellEjectSpeed', '弹壳抛出速度', 0, 15, 0.1, 'm/s', false],
    ['impactSparkScale', '弹着火花尺寸', 0.1, 3, 0.05, 'x'],
  ]},
  { group: 'reload', label: '换弹/切枪/ADS', items: [
    ['switchFireCd', '切枪时间', 0.1, 1.5, 0.01, 's'],
    ['adsInSpeed', 'ADS 进入速率', 1, 30, 0.5, '/s'],
    ['adsOutSpeed', 'ADS 退出速率', 1, 30, 0.5, '/s'],
    ['reloadScale', '换弹时长缩放', 0.2, 3, 0.05, 'x', false],
    ['interruptible', '换弹可打断', 0, 1, 1, '', false, 'bool'],
  ]},
  { group: 'viewmodel', label: '第一人称姿态 VIEWMODEL', items: [
    ['bobAmpX', '武器起伏 X', 0, 0.1, 0.001, 'm'],
    ['bobAmpY', '武器起伏 Y', 0, 0.1, 0.001, 'm'],
    ['lagYaw', '转向拖曳 Y', 0, 2, 0.01, 'x'],
    ['lagPitch', '转向拖曳 X', 0, 2, 0.01, 'x'],
    ['recoilKickZ', '后坐后挫', 0, 0.3, 0.005, 'm'],
    ['recoilKickPitch', '后坐抬枪', 0, 0.5, 0.005, 'rad'],
    ['sprintDrop', '疾跑压枪', 0, 0.4, 0.005, 'm'],
    ['sprintTilt', '疾跑倾角', 0, 1.2, 0.01, 'rad'],
  ]},
];

/* 预设槽：A 固定为「原始（改动前）」基线，用于 A/B 对比 */
export const FEEL_PRESETS = { A: null, B: null, C: null };
export const PRESET_LABELS = { A: '原始（改动前）', B: '预设 B（空）', C: '预设 C（空）' };

/* ============================================================
   实时遥测：四条曲线的环形缓冲（预分配，逐帧复用，零 GC）
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

/* 暴露到全局：调参面板与控制台都可直接读写 */
if (typeof window !== 'undefined') window.__feel = feel;
