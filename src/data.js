/* ============================================================
   data.js — 世界设定 / 品牌 / 装备 / 人员 / 任务文案
   所有机构、品牌、人物均为原创虚构。
   ============================================================ */

export const FICTION = {
  authority: 'MERIDIAN PORT AUTHORITY',
  authorityCn: '子午线港务局',
  operation: 'SILENT BERTH',
  operationCn: '静默泊位',
  /* 原创虚构品牌 / 标识，均非现实企业 */
  brands: {
    logistics:  'VOLKERSTADT LOGISTIK',
    shipping:   'HANSA MERIDIAN SHIPPING',
    crane:      'NORDBRÜCKE CRANE CO.',
    containers: 'KRG-9 CARGO',
    arms:       'VANTOR ARMS',
    optics:     'HALCYON OPTIK',
    security:   'TALOS SICHERHEIT',
    cold:       'EISWERK KÜHLHAUS',
    fuel:       'PETROVANE',
  },
};

/* ---------- 键位 ---------- */
export const KEYS = {
  follow:  { code: 'Digit1', label: '1', cn: '编队跟随', en: 'FOLLOW'  },
  hold:    { code: 'Digit2', label: '2', cn: '原地待命', en: 'HOLD'    },
  clear:   { code: 'Digit3', label: '3', cn: '移动清场', en: 'CLEAR'   },
  regroup: { code: 'Digit4', label: '4', cn: '归队',     en: 'REGROUP' },
};

export const ORDER_NAMES = {
  follow:  { cn: '编队跟随', en: 'FOLLOW' },
  hold:    { cn: '原地待命', en: 'HOLD' },
  clear:   { cn: '移动清场', en: 'MOVE & CLEAR' },
  regroup: { cn: '归队',     en: 'REGROUP' },
  engage:  { cn: '自由交战', en: 'WEAPONS FREE' },
  escort:  { cn: '护送平民', en: 'ESCORT' },
};

/* ---------- 装备 ---------- */
export const WEAPONS = {
  mr4: {
    id: 'mr4', cls: 'primary', brand: 'VANTOR ARMS', name: 'MR-4 短管步枪',
    short: 'VANTOR MR-4', mode: 'AUTO',
    damage: 24, rpm: 640, mag: 30, reserve: 150, reload: 2.35,
    spread: 0.010, adsSpread: 0.0035, moveSpread: 0.020,
    recoil: 1.0, muzzle: 0.9, range: 120, adsFov: 46,
    desc: '港务警备处制式短管步枪，射速可控，夜间首发精度稳定。',
    stats: { 杀伤: 62, 射速: 74, 精度: 70, 操控: 66 },
  },
  vk12: {
    id: 'vk12', cls: 'primary', brand: 'KELLNER & ROEG', name: 'VK-12 战术霰弹',
    short: 'KELLNER VK-12', mode: 'PUMP',
    damage: 13, pellets: 9, rpm: 78, mag: 7, reserve: 42, reload: 0.55,
    spread: 0.045, adsSpread: 0.030, moveSpread: 0.058,
    recoil: 2.6, muzzle: 1.5, range: 34, adsFov: 52,
    desc: '近距离压制力极强，室内清场首选；远距离几乎无效，误伤风险高。',
    stats: { 杀伤: 88, 射速: 22, 精度: 34, 操控: 48 },
  },
  k9: {
    id: 'k9', cls: 'primary', brand: 'VANTOR ARMS', name: 'K-9 冲锋枪',
    short: 'VANTOR K-9', mode: 'AUTO',
    damage: 17, rpm: 840, mag: 25, reserve: 145, reload: 2.0,
    spread: 0.016, adsSpread: 0.007, moveSpread: 0.026,
    recoil: 0.75, muzzle: 0.7, range: 80, adsFov: 50,
    desc: '紧凑、安静、后坐柔和，适合在狭窄仓道中控制弹道。',
    stats: { 杀伤: 50, 射速: 86, 精度: 58, 操控: 82 },
  },
  p9: {
    id: 'p9', cls: 'sidearm', brand: 'KOVAR ARMS', name: 'P9 制式手枪',
    short: 'KOVAR P9', mode: 'SEMI',
    damage: 22, rpm: 320, mag: 17, reserve: 68, reload: 1.75,
    spread: 0.014, adsSpread: 0.005, moveSpread: 0.024,
    recoil: 1.1, muzzle: 0.85, range: 55, adsFov: 54,
    desc: '警备处标准配枪，随时可用。',
    stats: { 杀伤: 46, 射速: 44, 精度: 62, 操控: 90 },
  },
  r7: {
    id: 'r7', cls: 'sidearm', brand: 'KOVAR ARMS', name: 'R-7 左轮手枪',
    short: 'KOVAR R-7', mode: 'REVOLVER',
    damage: 52, rpm: 130, mag: 6, reserve: 30, reload: 3.1,
    spread: 0.013, adsSpread: 0.004, moveSpread: 0.026,
    recoil: 2.1, muzzle: 1.3, range: 70, adsFov: 54,
    desc: '单发威力最大的备用选择，射速与装填代价高昂。',
    stats: { 杀伤: 80, 射速: 16, 精度: 70, 操控: 44 },
  },
};

export const GADGETS = {
  flash: {
    id: 'flash', name: '闪光弹 ×3', short: '闪光弹',
    desc: '爆响与强光使目标短暂失去反应。对未识别的目标使用不会造成致命后果。',
    count: 3, radius: 13, fuse: 1.5,
  },
  smoke: {
    id: 'smoke', name: '烟幕弹 ×3', short: '烟幕弹',
    desc: '切断视线，用于掩护小队穿越开阔堆场，或阻断嫌疑人射击线。',
    count: 3, radius: 11, fuse: 1.2,
  },
  breach: {
    id: 'breach', name: '破门装药 ×2', short: '破门装药',
    desc: '炸开上锁的门。爆炸声会惊动整个港区。',
    count: 2, radius: 6, fuse: 2.2,
  },
  trauma: {
    id: 'trauma', name: '急救包 ×2', short: '急救包',
    desc: '对倒地的小队成员使用（E）可使其重新归队，但会留下永久损伤影响。',
    count: 2, radius: 3, fuse: 1.0,
  },
};

export const ARMORS = {
  light: {
    id: 'light', name: '轻量防弹背心', short: 'LIGHT',
    desc: '牺牲防护换取速度与耐力。移动和识别更迅速。',
    hp: 100, speed: 1.12, stamina: 1.15,
  },
  standard: {
    id: 'standard', name: '制式防弹背心', short: 'STANDARD',
    desc: '港务警备处标准配置，均衡。',
    hp: 120, speed: 1.0, stamina: 1.0,
  },
  heavy: {
    id: 'heavy', name: '重装战术背心', short: 'HEAVY',
    desc: '可挡下多轮步枪命中，但移动迟缓、转向笨重。',
    hp: 165, speed: 0.86, stamina: 0.78,
  },
};

export const DEFAULT_LOADOUT = {
  primary: 'mr4',
  sidearm: 'p9',
  gadget: 'flash',
  armor: 'standard',
};

/* ---------- 小队 ---------- */
export const SQUAD_ROSTER = [
  { id: 'L', callsign: 'LEAD',   name: '你 · 队长', role: 'SQUAD LEADER',   lead: true },
  { id: 'A', callsign: 'ARDEN-2', name: 'K. 阿登',  role: '步枪手 · 侦察', tag: 'RIFLEMAN' },
  { id: 'B', callsign: 'BRAM-3',  name: 'S. 布拉姆', role: '步枪手 · 火力', tag: 'RIFLEMAN' },
  { id: 'C', callsign: 'CIRA-4',  name: 'M. 席拉',   role: '突击手 · 破障', tag: 'BREACHER' },
  { id: 'D', callsign: 'DOV-5',   name: 'L. 多夫',   role: '支援 · 医务',   tag: 'MEDIC' },
];

/* ---------- 任务文案 ---------- */
export const OBJECTIVES = [
  { id: 'manifest', label: '找回货运货单', sub: '三号仓 · BAY 3 办公室', primary: true },
  { id: 'evidence', label: '搜集调度室证据', sub: '港区调度楼 · 监控与登记记录', primary: true },
  { id: 'civilians', label: '保护平民', sub: '接触夜班工人并护送至南门', primary: true },
  { id: 'suspects', label: '处理武装嫌疑人', sub: '拘押优先于击毙（次要）', primary: false },
  { id: 'extract', label: '撤出港区', sub: '返回南门装甲车', primary: true },
];

export const ROE = {
  civilianKillIsFail: true,
  rewardObserve: true,
};

/* ---------- 无线电呼号 ---------- */
export const COMMS = {
  lead: '队长',
  squadName: 'ARDEN',
  hostileNet: '白鹭',
};

/* ---------- 台词 ---------- */
export const LINES = {
  squadIdArmed: [
    '{who}：接触 — 武装，{dir}。',
    '{who}：发现持械人员，方位 {dir}。',
    '{who}：确认武器，{dir}，等待指令。',
  ],
  squadIdCiv: [
    '{who}：那边是平民，{dir}。',
    '{who}：识别为夜班工人，{dir}。',
    '{who}：非战斗人员，{dir}。',
  ],
  squadSpotUnknown: [
    '{who}：有动静，{dir}。看不清楚。',
    '{who}：前方有移动目标，{dir}，需要识别。',
  ],
  onContact: [
    '{who}：接敌！',
    '{who}：遭遇射击，找掩护！',
    '{who}：压制他们！',
  ],
  onClear: [
    '{who}：清空，继续推进。',
    '{who}：区域安全。',
  ],
  onHold: [
    '{who}：收到，原地警戒。',
  ],
  onFollow: [
    '{who}：跟上队长，保持队形。',
  ],
  surrender: [
    '嫌疑人：别开枪！我放下枪！',
    '嫌疑人：投降！我投降！',
  ],
  civFound: [
    '工人：别开枪！我们是夜班工！',
    '工人：谢天谢地……快带我出去。',
  ],
  civSafe: [
    '调度：平民已进入南门集结点。',
  ],
  objManifest: [
    '队长：货单到手。',
  ],
  objEvidence: [
    '队长：调度记录提取完成。',
  ],
  alert: [
    '敌方电台：有人进来了，收拢。',
    '敌方电台：白鹭呼叫，有人闯港区。',
  ],
};

export const DIRECTIONS = ['12 点','1 点','2 点','3 点','4 点','5 点','6 点','7 点','8 点','9 点','10 点','11 点'];

/* ---------- 地图配色（战术地图与小地图共用） ---------- */
export const MAP_COLORS = {
  friendly:  '#4ea8ff',   // 主角与队友 —— 蓝
  enemy:     '#ff9a3c',   // 已识别的敌人 —— 橙
  event:     '#ffd447',   // 事件（枪声 / 警讯 / 爆炸 / 情报 / 伤亡）—— 黄
  civilian:  '#8ee08a',   // 平民 —— 绿（必须与敌人区分，避免误伤）
  objective: '#f2b64a',   // 任务点 —— 琥珀（菱形，与事件点区分）
  unknown:   '#9aa6b0',   // 未识别接触 —— 灰（保持“先观察再下令”的设计）
};

/* ---------- 难度 / 平衡 ---------- */
export const TUNING = {
  timeScaleNormal: 1,
  timeScalePause: 0.10,
  identifyRate: 0.34,      // 每秒基础识别进度
  identifyRateADS: 1.5,    // 举枪倍率
  identifyRateFast: 0.0,   // 由装备修正
  identifyNearBonus: 1.6,  // 近距离识别加成
  squadIdShare: 0.55,      // 小队成员共享识别的速率
  suspectVision: 42,
  suspectFov: Math.cos(1.15),
  civilianPanic: 26,
  playerHpBase: 120,
};
