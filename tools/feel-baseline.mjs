/* ============================================================
   tools/feel-baseline.mjs - 手感回归基线（固定步长，逐位可复现）
   ------------------------------------------------------------
   用 1/60s 固定步长驱动 game.advance()，屏蔽 rAF 抖动与渲染差异。
   用法：
     node tools/feel-baseline.mjs capture tools/feel-baseline.json
     node tools/feel-baseline.mjs compare tools/feel-baseline.json
   ============================================================ */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Suite, ROOT as root } from './harness.mjs';

const suite = new Suite('feel-baseline');
const server = await suite.serve({ port: 8209 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await suite.newPage();
/* 固定随机序列：水平后坐力等处使用 Math.random，必须可复现 */
await page.evaluateOnNewDocument(() => {
  let seed = 0x2f6e2b1;
  window.__randCalls = 0;
  Math.random = () => {
    window.__randCalls++;
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  /* 供基准脚本在「随机敏感的测量点」前把随机流钉到固定位置。
     没有这个的话，任何在别处改变了 Math.random 消费次数的改动（例如 AI 逻辑）
     都会让 recoil.yawSeq 整段错位 —— 那测的是「随机流位置」，不是后坐力逻辑。 */
  window.__reseed = (v = 0x2f6e2b1) => { seed = v >>> 0; window.__randCalls = 0; };
});
await page.goto('http://127.0.0.1:8209/?deploy=1&test=1', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2600));   // ?test=1 已冻结 rAF 步进，热身不再引入随机流漂移

const data = await page.evaluate(() => {
  const g = window.__game;
  const P = g.player;
  const DT = 1 / 60;
  g.testMode = true;   // 双保险（URL 参数已设置）
  const r6 = (v) => +v.toFixed(6);
  const r8 = (v) => +v.toFixed(8);

  const reset = () => {
    g.input.keys.clear();
    g.input.lmb = false; g.input.rmb = false; g.input.lmbPressed = false;
    P.pos.x = 0; P.pos.z = 0; P.yaw = 0; P.pitch = 0;
    P.ads = 0; P.reloading = 0; P.fireCd = 0; P.burstCount = 0;
    P.recoil.pitch = 0; P.recoil.yaw = 0;
    P.stamina = 1; P.suppression = 0; P.blind = 0; P.vel = 0;
    P.mag.primary = P.primaryDef.mag; P.reserve.primary = P.primaryDef.reserve;
    P.active = 'primary'; P.shotLog.length = 0; P.lastShotIndex = 0; P.lastSpread = 0;
    g.suspects.forEach((s, i) => { s.pos.x = 900 + i; s.pos.z = 900; });
    g.civilians.forEach((c, i) => { c.pos.x = 900 + i; c.pos.z = 900; });
    g.squad.forEach((m, i) => { m.pos.x = -900 - i; m.pos.z = -900; });
    g.mapEvents.length = 0;
  };
  const step = (n) => { for (let i = 0; i < n; i++) g.advance(DT, DT); };

  const out = {};

  /* 1. 各姿态稳态速度与 FOV（跑 1 秒后按位移反算） */
  const measure = (keys, rmb) => {
    reset();
    keys.forEach((k) => g.input.keys.add(k));
    if (rmb) g.input.rmb = true;
    step(30);
    const x0 = P.pos.x, z0 = P.pos.z;
    step(60);
    const dist = Math.hypot(P.pos.x - x0, P.pos.z - z0);
    return { speed: r6(dist), fov: r6(g.camera.fov), ads: r6(P.ads) };
  };
  out.move = {
    walk: measure(['KeyW'], false),
    sprint: measure(['KeyW', 'ShiftLeft'], false),
    crouch: measure(['KeyW', 'ControlLeft'], false),
    ads: measure(['KeyW'], true),
    diag: measure(['KeyW', 'KeyD'], false),
    back: measure(['KeyS'], false),
  };

  /* 2. 起步斜坡与松手刹车（当前应为瞬时 ⇒ 首步即满速、松手即停） */
  reset();
  g.input.keys.add('KeyW');
  const ramp = [];
  let px = P.pos.x, pz = P.pos.z;
  for (let i = 0; i < 6; i++) {
    g.advance(DT, DT);
    ramp.push(r6(Math.hypot(P.pos.x - px, P.pos.z - pz) / DT));
    px = P.pos.x; pz = P.pos.z;
  }
  g.input.keys.delete('KeyW');
  g.advance(DT, DT);
  out.ramp = { perStep: ramp, afterRelease: r6(Math.hypot(P.pos.x - px, P.pos.z - pz) / DT) };

  /* 3. 相机：行走时的 roll 峰值与头部起伏 */
  reset();
  g.input.keys.add('KeyW');
  let rollMax = 0, bobY = 0;
  const eyeY = P.eye.y;
  for (let i = 0; i < 180; i++) {
    g.advance(DT, DT);
    rollMax = Math.max(rollMax, Math.abs(g.camera.rotation.z));
    bobY = Math.max(bobY, Math.abs(g.camera.position.y - eyeY));
  }
  out.camera = { rollMax: r6(rollMax), bobY: r6(bobY) };

  /* 4. 扩散：连发累积 */
  reset();
  P.logShots = true;
  g.input.lmb = true;
  step(90);
  g.input.lmb = false;
  out.spread = {
    shots: P.shotLog.length,
    first: r8(P.shotLog[0] ? P.shotLog[0].s : 0),
    last: r8(P.shotLog.length ? P.shotLog[P.shotLog.length - 1].s : 0),
  };

  /* 5. 后坐力：逐发累积（帧间不衰减）与序列可复现性 */
  const pitchAfter = (k) => {
    reset(); P.logShots = true;
    for (let i = 0; i < k; i++) { P.fireCd = 0; P.fireOnce(); }
    return r8(P.recoil.pitch);
  };
  out.recoil = {
    pitchAfter: [1, 2, 3, 5, 8, 13].map(pitchAfter),
    /* 水平后坐力逐发取自 Math.random，因此先把随机流钉到固定位置再测，
       否则这段序列会被「别处多消耗了几次随机数」整体推移。 */
    yawSeq: (() => {
      reset(); window.__reseed(0x51ed); P.logShots = true;
      for (let i = 0; i < 5; i++) { P.fireCd = 0; P.fireOnce(); }
      return P.shotLog.map((v) => r8(v.y));
    })(),
  };
  reset();
  for (let i = 0; i < 5; i++) { P.fireCd = 0; P.fireOnce(); }
  const decay0 = P.recoil.pitch;
  step(60);
  out.recoil.decay = { start: r8(decay0), afterOneSecond: r8(P.recoil.pitch) };

  /* 6. 换弹 / 切枪 / ADS 过渡 */
  reset();
  P.mag.primary = 0; P.startReload();
  let rs = 0;
  while (P.reloading > 0 && rs < 900) { g.advance(DT, DT); rs++; }
  out.reload = { seconds: r6(rs * DT), magAfter: P.mag.primary };
  reset();
  const before = P.active;
  P.switchWeapon();
  out.reload.switchSeconds = r6(P.fireCd);
  out.reload.switched = before !== P.active;
  reset();
  g.input.rmb = true;
  let ain = 0;
  while (P.ads < 0.999 && ain < 600) { g.advance(DT, DT); ain++; }
  out.reload.adsInSeconds = r6(ain * DT);
  g.input.rmb = false;
  let aout = 0;
  while (P.ads > 0.001 && aout < 600) { g.advance(DT, DT); aout++; }
  out.reload.adsOutSeconds = r6(aout * DT);

  /* 7. 反馈：震动包络与枪口闪光时长 */
  reset();
  g.shake(0.28, 0.12);
  out.feedback = { shakeStart: r6(g.camShake) };
  step(30);
  out.feedback.shakeAfterHalfSecond = r6(g.camShake);
  reset();
  P.fireCd = 0; P.fireOnce();
  out.feedback.muzzleTimer = r6(g.effects.muzzleTimer);
  out.feedback.hitmarkerTime = r6(0);

  /* 8. 元信息（用于确认测的就是当前配装） */
  out.meta = {
    randCalls: window.__randCalls,
    armorSpeed: P.armor.speed, armorHp: P.armor.hp,
    weapon: P.def.id, rpm: P.def.rpm, range: P.def.range,
    spread: P.def.spread, adsSpread: P.def.adsSpread, moveSpread: P.def.moveSpread,
    reloadTime: P.def.reload, damage: P.def.damage,
  };

  P.logShots = false;
  g.testMode = false;
  return out;
});

const mode = process.argv[2] || 'capture';
const file = process.argv[3] || join(root, 'tools', 'feel-baseline.json');

if (mode === 'capture') {
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  console.log('已采集基线 -> ' + file);
  console.log(JSON.stringify(data, null, 2));
  suite.check('采集期间页面无异常', suite.pageErrors.length === 0, suite.pageErrors.slice(0, 2).join(' | '));
  await suite.finish();
} else {
  const old = JSON.parse(await readFile(file, 'utf8'));
  const diffs = [];
  const walk = (a, b, path) => {
    if (typeof a === 'number' && typeof b === 'number') {
      const d = Math.abs(a - b);
      const m = Math.max(Math.abs(a), Math.abs(b));
      const rel = m > 1e-9 ? d / m : 0;
      if (d > 1e-6 && rel > 1e-6) diffs.push(path + ': ' + a + ' -> ' + b + ' (d=' + d.toExponential(3) + ')');
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) { diffs.push(path + ': 长度 ' + a.length + ' -> ' + b.length); return; }
      a.forEach((v, i) => walk(v, b[i], path + '[' + i + ']'));
      return;
    }
    if (a && b && typeof a === 'object') {
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      for (const k of keys) walk(a[k], b[k], path ? path + '.' + k : k);
      return;
    }
    if (a !== b) diffs.push(path + ': ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b));
  };
  walk(old, data, '');
  /* meta.* 是「随机流位置」之类的诊断量，不是手感指标。
     任何在别处改变了 Math.random 消费次数的改动都会让它变化，
     若把它算作回归，「手感基线变红」就会变成噪声 —— 只报告、不判失败。
     （recoil.yawSeq 已在采集前用 __reseed 钉住随机流，因此仍可作为硬断言。） */
  const feelDiffs = diffs.filter((d) => !d.startsWith('meta.'));
  const infoDiffs = diffs.filter((d) => d.startsWith('meta.'));
  console.log('');
  console.log('===== 手感回归比对 =====');
  if (!feelDiffs.length) console.log('[PASS] 手感指标与基线逐位相同（行为零变化）');
  else {
    console.log('[FAIL] 发现 ' + feelDiffs.length + ' 处手感差异：');
    feelDiffs.slice(0, 40).forEach((d) => console.log('   ' + d));
  }
  if (infoDiffs.length) {
    console.log('[info] ' + infoDiffs.length + ' 处诊断量变化（不计入失败）：');
    infoDiffs.slice(0, 6).forEach((d) => console.log('   ' + d));
  }
  suite.check('手感指标与基线逐位一致', feelDiffs.length === 0, feelDiffs.slice(0, 3).join(' | '));
  await suite.finish();   // 页面异常在这里一并计入退出码（原先的打印在 exit 之后，永远不可达）
}
