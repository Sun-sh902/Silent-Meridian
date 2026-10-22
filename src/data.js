/* ============================================================
   data.js — world setting / brands / equipment / personnel / mission text
   All agencies, brands and people are original fictional creations.
   ============================================================ */

export const FICTION = {
  authority: 'MERIDIAN PORT AUTHORITY',
  authorityCn: 'MERIDIAN PORT AUTHORITY',
  operation: 'SILENT BERTH',
  operationCn: 'SILENT BERTH',
  /* Original fictional brands / marks; none are real companies */
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
  follow:  { code: 'Digit1', label: '1', cn: 'FOLLOW',  en: 'FOLLOW'  },
  hold:    { code: 'Digit2', label: '2', cn: 'HOLD',    en: 'HOLD'    },
  clear:   { code: 'Digit3', label: '3', cn: 'MOVE & CLEAR', en: 'CLEAR'   },
  regroup: { code: 'Digit4', label: '4', cn: 'REGROUP', en: 'REGROUP' },
};

export const ORDER_NAMES = {
  follow:  { cn: 'FOLLOW', en: 'FOLLOW' },
  hold:    { cn: 'HOLD', en: 'HOLD' },
  clear:   { cn: 'MOVE & CLEAR', en: 'MOVE & CLEAR' },
  regroup: { cn: 'REGROUP', en: 'REGROUP' },
  engage:  { cn: 'WEAPONS FREE', en: 'WEAPONS FREE' },
  escort:  { cn: 'ESCORT', en: 'ESCORT' },
};

/* ---------- Equipment ---------- */
export const WEAPONS = {
  mr4: {
    id: 'mr4', cls: 'primary', brand: 'VANTOR ARMS', name: 'MR-4 Short-Barreled Rifle',
    short: 'VANTOR MR-4', mode: 'AUTO',
    damage: 24, rpm: 640, mag: 30, reserve: 150, reload: 2.35,
    spread: 0.010, adsSpread: 0.0035, moveSpread: 0.020,
    recoil: 1.0, muzzle: 0.9, range: 120, adsFov: 46,
    desc: 'Port Security standard-issue short-barreled rifle. Controllable rate of fire, stable first-shot accuracy at night.',
    stats: { LETHALITY: 62, 'RATE OF FIRE': 74, ACCURACY: 70, HANDLING: 66 },
  },
  vk12: {
    id: 'vk12', cls: 'primary', brand: 'KELLNER & ROEG', name: 'VK-12 Tactical Shotgun',
    short: 'KELLNER VK-12', mode: 'PUMP',
    damage: 13, pellets: 9, rpm: 78, mag: 7, reserve: 42, reload: 0.55,
    spread: 0.045, adsSpread: 0.030, moveSpread: 0.058,
    recoil: 2.6, muzzle: 1.5, range: 34, adsFov: 52,
    desc: 'Devastating suppression at close range, first choice for clearing rooms; nearly useless at distance, with a high risk of collateral hits.',
    stats: { LETHALITY: 88, 'RATE OF FIRE': 22, ACCURACY: 34, HANDLING: 48 },
  },
  k9: {
    id: 'k9', cls: 'primary', brand: 'VANTOR ARMS', name: 'K-9 Submachine Gun',
    short: 'VANTOR K-9', mode: 'AUTO',
    damage: 17, rpm: 840, mag: 25, reserve: 145, reload: 2.0,
    spread: 0.016, adsSpread: 0.007, moveSpread: 0.026,
    recoil: 0.75, muzzle: 0.7, range: 80, adsFov: 50,
    desc: 'Compact, quiet and softly recoiling; suited to keeping rounds on line in narrow warehouse aisles.',
    stats: { LETHALITY: 50, 'RATE OF FIRE': 86, ACCURACY: 58, HANDLING: 82 },
  },
  p9: {
    id: 'p9', cls: 'sidearm', brand: 'KOVAR ARMS', name: 'P9 Service Pistol',
    short: 'KOVAR P9', mode: 'SEMI',
    damage: 22, rpm: 320, mag: 17, reserve: 68, reload: 1.75,
    spread: 0.014, adsSpread: 0.005, moveSpread: 0.024,
    recoil: 1.1, muzzle: 0.85, range: 55, adsFov: 54,
    desc: 'The Security Office standard sidearm. Always available.',
    stats: { LETHALITY: 46, 'RATE OF FIRE': 44, ACCURACY: 62, HANDLING: 90 },
  },
  r7: {
    id: 'r7', cls: 'sidearm', brand: 'KOVAR ARMS', name: 'R-7 Revolver',
    short: 'KOVAR R-7', mode: 'REVOLVER',
    damage: 52, rpm: 130, mag: 6, reserve: 30, reload: 3.1,
    spread: 0.013, adsSpread: 0.004, moveSpread: 0.026,
    recoil: 2.1, muzzle: 1.3, range: 70, adsFov: 54,
    desc: 'The hardest-hitting backup option, at a steep cost in rate of fire and reload time.',
    stats: { LETHALITY: 80, 'RATE OF FIRE': 16, ACCURACY: 70, HANDLING: 44 },
  },
};

export const GADGETS = {
  flash: {
    id: 'flash', name: 'Flashbang ×3', short: 'Flashbang',
    desc: 'A blast and a flash briefly take the target out of the fight. Using one on an unidentified target has no lethal consequences.',
    count: 3, radius: 13, fuse: 1.5,
  },
  smoke: {
    id: 'smoke', name: 'Smoke Grenade ×3', short: 'Smoke',
    desc: 'Cuts line of sight, covering the squad across open yard or breaking a suspect\'s firing line.',
    count: 3, radius: 11, fuse: 1.2,
  },
  breach: {
    id: 'breach', name: 'Breaching Charge ×2', short: 'Breach Charge',
    desc: 'Blows a locked door open. The blast will alert the entire port.',
    count: 2, radius: 6, fuse: 2.2,
  },
  trauma: {
    id: 'trauma', name: 'Trauma Kit ×2', short: 'Trauma Kit',
    desc: 'Use on a downed squad member (E) to get them back on their feet, at the cost of a permanent injury.',
    count: 2, radius: 3, fuse: 1.0,
  },
};

export const ARMORS = {
  light: {
    id: 'light', name: 'Light Ballistic Vest', short: 'LIGHT',
    desc: 'Trades protection for speed and stamina. Move and identify faster.',
    hp: 100, speed: 1.12, stamina: 1.15,
  },
  standard: {
    id: 'standard', name: 'Standard Ballistic Vest', short: 'STANDARD',
    desc: 'Port Security standard issue. Balanced.',
    hp: 120, speed: 1.0, stamina: 1.0,
  },
  heavy: {
    id: 'heavy', name: 'Heavy Tactical Vest', short: 'HEAVY',
    desc: 'Stops multiple rifle hits, but slows movement and makes turning sluggish.',
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
  { id: 'L', callsign: 'LEAD',   name: 'You · Team Leader', role: 'SQUAD LEADER',   lead: true },
  { id: 'A', callsign: 'ARDEN-2', name: 'K. Arden',  role: 'Rifleman · Scout', tag: 'RIFLEMAN' },
  { id: 'B', callsign: 'BRAM-3',  name: 'S. Bram', role: 'Rifleman · Support', tag: 'RIFLEMAN' },
  { id: 'C', callsign: 'CIRA-4',  name: 'M. Cira',   role: 'Breacher · Assault', tag: 'BREACHER' },
  { id: 'D', callsign: 'DOV-5',   name: 'L. Dov',   role: 'Support · Medic',   tag: 'MEDIC' },
];

/* ---------- Mission text ---------- */
export const OBJECTIVES = [
  { id: 'manifest', label: 'Recover the cargo manifest', sub: 'BAY 3 · office', primary: true },
  { id: 'evidence', label: 'Gather dispatch evidence', sub: 'Dispatch building · surveillance and registration records', primary: true },
  { id: 'civilians', label: 'Protect civilians', sub: 'Reach the night-shift workers and escort them to the south gate', primary: true },
  { id: 'suspects', label: 'Handle armed suspects', sub: 'Detention takes priority over killing (secondary)', primary: false },
  { id: 'extract', label: 'Extract from the port', sub: 'Return to the south gate armored vehicle', primary: true },
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

/* ---------- Voice lines ---------- */
export const LINES = {
  squadIdArmed: [
    '{who}: Contact — armed, {dir}.',
    '{who}: Armed man, bearing {dir}.',
    '{who}: Weapon confirmed, {dir}, awaiting orders.',
  ],
  squadIdCiv: [
    '{who}: That\'s a civilian, {dir}.',
    '{who}: Identified as night-shift worker, {dir}.',
    '{who}: Non-combatant, {dir}.',
  ],
  squadSpotUnknown: [
    '{who}: Movement, {dir}. Can\'t make it out.',
    '{who}: Movement ahead, {dir}, needs identification.',
  ],
  onContact: [
    '{who}: Contact!',
    '{who}: Taking fire, find cover!',
    '{who}: Suppress them!',
  ],
  onClear: [
    '{who}: Clear, continue the advance.',
    '{who}: Area secure.',
  ],
  onHold: [
    '{who}: Copy, holding and watching.',
  ],
  onFollow: [
    '{who}: On the lead, keep formation.',
  ],
  surrender: [
    'Suspect: Don\'t shoot! I\'m putting the gun down!',
    'Suspect: I surrender! I surrender!',
  ],
  civFound: [
    'Worker: Don\'t shoot! We\'re the night shift!',
    'Worker: Thank God… get me out of here.',
  ],
  civSafe: [
    'Dispatch: Civilian has reached the south gate rally point.',
  ],
  objManifest: [
    'Lead: Manifest secured.',
  ],
  objEvidence: [
    'Lead: Dispatch records extracted.',
  ],
  alert: [
    'Hostile radio: Someone\'s inside. Close it up.',
    'Hostile radio: EGRET calling, intruders in the port.',
  ],
};

export const DIRECTIONS = ['12 o\'clock','1 o\'clock','2 o\'clock','3 o\'clock','4 o\'clock','5 o\'clock','6 o\'clock','7 o\'clock','8 o\'clock','9 o\'clock','10 o\'clock','11 o\'clock'];

/* ---------- Map colors (shared by tactical map and minimap) ---------- */
export const MAP_COLORS = {
  friendly:  '#4ea8ff',   // player and teammates — blue
  enemy:     '#ff9a3c',   // identified enemies — orange
  event:     '#ffd447',   // events (gunfire / alarm / explosion / intel / casualty) — yellow
  civilian:  '#8ee08a',   // civilians — green (must stay distinct from enemies to avoid collateral hits)
  objective: '#f2b64a',   // objectives — amber (diamonds, distinct from event dots)
  unknown:   '#9aa6b0',   // unidentified contact — grey (preserves the "observe first, then order" design)
};

/* ---------- Difficulty / balance ---------- */
export const TUNING = {
  timeScaleNormal: 1,
  timeScalePause: 0.10,
  identifyRate: 0.34,      // base identification progress per second
  identifyRateADS: 1.5,    // ADS multiplier
  identifyRateFast: 0.0,   // modified by equipment
  identifyNearBonus: 1.6,  // close-range identification bonus
  squadIdShare: 0.55,      // rate at which squad members share identification
  suspectVision: 42,
  suspectFov: Math.cos(1.15),
  civilianPanic: 26,
  playerHpBase: 120,
};
