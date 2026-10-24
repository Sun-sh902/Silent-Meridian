/* ============================================================
   data.js — setting / brands / equipment / personnel / mission copy
   All agencies, brands and people are original fiction.
   ============================================================ */

export const FICTION = {
  authority: 'MERIDIAN PORT AUTHORITY',
  operation: 'SILENT BERTH',
  /* Invented brands / marks; none are real companies */
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

/* ---------- Key bindings ---------- */
export const KEYS = {
  follow:  { code: 'Digit1', key: '1', label: 'Follow',      en: 'FOLLOW'  },
  hold:    { code: 'Digit2', key: '2', label: 'Hold',        en: 'HOLD'    },
  clear:   { code: 'Digit3', key: '3', label: 'Move & clear', en: 'CLEAR'   },
  regroup: { code: 'Digit4', key: '4', label: 'Regroup',     en: 'REGROUP' },
};

export const ORDER_NAMES = {
  follow:  { label: 'Follow, wedge', en: 'FOLLOW' },
  hold:    { label: 'Hold position', en: 'HOLD' },
  clear:   { label: 'Move & clear',  en: 'MOVE & CLEAR' },
  regroup: { label: 'Regroup',       en: 'REGROUP' },
  engage:  { label: 'Weapons free',  en: 'WEAPONS FREE' },
  escort:  { label: 'Escort civilian', en: 'ESCORT' },
};

/* ---------- Equipment ---------- */
export const WEAPONS = {
  mr4: {
    id: 'mr4', cls: 'primary', brand: 'VANTOR ARMS', name: 'MR-4 Carbine',
    short: 'VANTOR MR-4', mode: 'AUTO',
    damage: 24, rpm: 640, mag: 30, reserve: 150, reload: 2.35,
    spread: 0.010, adsSpread: 0.0035, moveSpread: 0.020,
    recoil: 1.0, muzzle: 0.9, range: 120, adsFov: 46,
    desc: 'Port Security issue carbine. Controllable rate, dependable first-round accuracy at night.',
    stats: { DMG: 62, ROF: 74, ACC: 70, HDL: 66 },
  },
  vk12: {
    id: 'vk12', cls: 'primary', brand: 'KELLNER & ROEG', name: 'VK-12 Pump Shotgun',
    short: 'KELLNER VK-12', mode: 'PUMP',
    damage: 13, pellets: 9, rpm: 78, mag: 7, reserve: 42, reload: 0.55,
    spread: 0.045, adsSpread: 0.030, moveSpread: 0.058,
    recoil: 2.6, muzzle: 1.5, range: 34, adsFov: 52,
    desc: 'Decisive at room distance; the default for interior clearing. Useless past 30 m, high collateral risk.',
    stats: { DMG: 88, ROF: 22, ACC: 34, HDL: 48 },
  },
  k9: {
    id: 'k9', cls: 'primary', brand: 'VANTOR ARMS', name: 'K-9 SMG',
    short: 'VANTOR K-9', mode: 'AUTO',
    damage: 17, rpm: 840, mag: 25, reserve: 145, reload: 2.0,
    spread: 0.016, adsSpread: 0.007, moveSpread: 0.026,
    recoil: 0.75, muzzle: 0.7, range: 80, adsFov: 50,
    desc: 'Compact, quiet, soft recoil. Keeps rounds on target in narrow aisles.',
    stats: { DMG: 50, ROF: 86, ACC: 58, HDL: 82 },
  },
  p9: {
    id: 'p9', cls: 'sidearm', brand: 'KOVAR ARMS', name: 'P9 Service Pistol',
    short: 'KOVAR P9', mode: 'SEMI',
    damage: 22, rpm: 320, mag: 17, reserve: 68, reload: 1.75,
    spread: 0.014, adsSpread: 0.005, moveSpread: 0.024,
    recoil: 1.1, muzzle: 0.85, range: 55, adsFov: 54,
    desc: 'Standard Port Security sidearm. Always ready.',
    stats: { DMG: 46, ROF: 44, ACC: 62, HDL: 90 },
  },
  r7: {
    id: 'r7', cls: 'sidearm', brand: 'KOVAR ARMS', name: 'R-7 Revolver',
    short: 'KOVAR R-7', mode: 'REVOLVER',
    damage: 52, rpm: 130, mag: 6, reserve: 30, reload: 3.1,
    spread: 0.013, adsSpread: 0.004, moveSpread: 0.026,
    recoil: 2.1, muzzle: 1.3, range: 70, adsFov: 54,
    desc: 'Heaviest single round in the locker. Pays for it in rate of fire and reload time.',
    stats: { DMG: 80, ROF: 16, ACC: 70, HDL: 44 },
  },
};

export const GADGETS = {
  flash: {
    id: 'flash', name: 'Flashbang ×3', short: 'Flashbang',
    desc: 'Blast and glare stun anyone in radius. Non-lethal — safe to use before a target is identified.',
    count: 3, radius: 13, fuse: 1.5,
  },
  smoke: {
    id: 'smoke', name: 'Smoke ×3', short: 'Smoke',
    desc: 'Breaks line of sight. Covers the squad across open yard or blocks a firing lane.',
    count: 3, radius: 11, fuse: 1.2,
  },
  breach: {
    id: 'breach', name: 'Breaching charge ×2', short: 'Breach',
    desc: 'Opens a locked door. The report will wake the entire port.',
    count: 2, radius: 6, fuse: 2.2,
  },
  trauma: {
    id: 'trauma', name: 'Trauma kit ×2', short: 'Trauma kit',
    desc: 'Use on a downed squad member (E) to get them back in the fight. The injury stays with them.',
    count: 2, radius: 3, fuse: 1.0,
  },
};

export const ARMORS = {
  light: {
    id: 'light', name: 'Light plate carrier', short: 'LIGHT',
    desc: 'Trades protection for speed and stamina. Faster to move, faster to identify.',
    hp: 100, speed: 1.12, stamina: 1.15,
  },
  standard: {
    id: 'standard', name: 'Standard vest', short: 'STANDARD',
    desc: 'Port Security standard issue. Balanced.',
    hp: 120, speed: 1.0, stamina: 1.0,
  },
  heavy: {
    id: 'heavy', name: 'Heavy assault vest', short: 'HEAVY',
    desc: 'Stops several rifle hits. Slow on the move, heavy in the turn.',
    hp: 165, speed: 0.86, stamina: 0.78,
  },
};

export const DEFAULT_LOADOUT = {
  primary: 'mr4',
  sidearm: 'p9',
  gadget: 'flash',
  armor: 'standard',
};

/* ---------- Squad ---------- */
export const SQUAD_ROSTER = [
  { id: 'L', callsign: 'LEAD',   name: 'You · Team lead', role: 'SQUAD LEADER', lead: true },
  { id: 'A', callsign: 'ARDEN-2', name: 'K. Arden', role: 'Rifleman · Recon',   tag: 'RIFLEMAN' },
  { id: 'B', callsign: 'BRAM-3',  name: 'S. Bram',  role: 'Rifleman · Fire support', tag: 'RIFLEMAN' },
  { id: 'C', callsign: 'CIRA-4',  name: 'M. Cira',  role: 'Breacher · Entry',   tag: 'BREACHER' },
  { id: 'D', callsign: 'DOV-5',   name: 'L. Dov',   role: 'Support · Medic',    tag: 'MEDIC' },
];

/* ---------- Mission copy ---------- */
export const OBJECTIVES = [
  { id: 'manifest', label: 'Recover cargo manifest', sub: 'Bay 3 · site office', primary: true },
  { id: 'evidence', label: 'Secure dispatch evidence', sub: 'Dispatch · CCTV and gate log', primary: true },
  { id: 'civilians', label: 'Protect civilians', sub: 'Locate night crew, escort to south gate', primary: true },
  { id: 'suspects', label: 'Neutralise armed suspects', sub: 'Detain over kill (secondary)', primary: false },
  { id: 'extract', label: 'Exfil', sub: 'RTB · APC at south gate', primary: true },
];

export const ROE = {
  civilianKillIsFail: true,
  rewardObserve: true,
};

/* ---------- Radio callsigns ---------- */
export const COMMS = {
  lead: 'LEAD',
  squadName: 'ARDEN',
  hostileNet: 'EGRET',
};

/* ---------- Lines ---------- */
export const LINES = {
  squadIdArmed: [
    '{who}: Contact — armed, {dir}.',
    '{who}: Weapon seen, {dir}.',
    '{who}: Armed, {dir}. Awaiting orders.',
  ],
  squadIdCiv: [
    '{who}: Civilian, {dir}.',
    '{who}: Night crew, {dir}. Hold fire.',
    '{who}: Non-combatant, {dir}.',
  ],
  squadSpotUnknown: [
    '{who}: Movement, {dir}. Can\'t make it out.',
    '{who}: Mover, {dir}. Needs eyes.',
  ],
  onContact: [
    '{who}: Contact!',
    '{who}: Taking fire — cover!',
    '{who}: Suppressing!',
  ],
  onClear: [
    '{who}: Clear. Pushing.',
    '{who}: Area secure.',
  ],
  onHold: [
    '{who}: Copy. Holding.',
  ],
  onFollow: [
    '{who}: On you, lead.',
  ],
  surrender: [
    'Suspect: Don\'t shoot! Weapon\'s down!',
    'Suspect: I give up! I give up!',
  ],
  civFound: [
    'Worker: Don\'t shoot — we\'re night crew!',
    'Worker: Thank God. Get me out of here.',
  ],
  civSafe: [
    'Dispatch: Civilian at the south gate RV.',
  ],
  objManifest: [
    'Lead: Manifest secured.',
  ],
  objEvidence: [
    'Lead: Dispatch logs pulled.',
  ],
  alert: [
    'Hostile net: Someone\'s inside. Pull in.',
    'Hostile net: Egret, Egret — we have company.',
  ],
};

export const DIRECTIONS = ['12 o\'clock','1 o\'clock','2 o\'clock','3 o\'clock','4 o\'clock','5 o\'clock','6 o\'clock','7 o\'clock','8 o\'clock','9 o\'clock','10 o\'clock','11 o\'clock'];

/* ---------- Map colours (shared by tactical map and minimap) ---------- */
export const MAP_COLORS = {
  friendly:  '#4ea8ff',   // player and squad — blue
  enemy:     '#ff9a3c',   // identified hostiles — orange
  event:     '#ffd447',   // events (gunfire / alarm / explosion / intel / casualty) — yellow
  civilian:  '#8ee08a',   // civilians — green (must differ from hostiles to prevent friendly fire)
  objective: '#f2b64a',   // objectives — amber (diamond, distinct from event dots)
  unknown:   '#9aa6b0',   // unidentified contacts — grey (keeps the "observe before ordering" design)
};

/* ---------- Difficulty / balance ---------- */
export const TUNING = {
  timeScaleNormal: 1,
  timeScalePause: 0.10,
  identifyRate: 0.34,      // base identification progress per second
  identifyRateADS: 1.5,    // ADS multiplier
  identifyRateFast: 0.0,   // set by equipment modifiers
  identifyNearBonus: 1.6,  // close-range identification bonus
  squadIdShare: 0.55,      // rate at which squad members share identification
  suspectVision: 42,
  suspectFov: Math.cos(1.15),
  civilianPanic: 26,
  playerHpBase: 120,
};
