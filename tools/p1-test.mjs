/* ============================================================
   tools/p1-test.mjs — P1 缺陷的复现与回归
   ------------------------------------------------------------
   P1-1 fireCd / blind 被 updateCommon 与 Player.update 双重递减
        （射速翻倍 + 闪光弹致盲时长砍半）
   P1-2 moveDir 用坐标「和」的变化量算速度 ⇒ 斜向移动 vel 恒为 0
   P1-3 AI 掩体不可达时：每帧一次全量 A*，且 return 跳过开火 ⇒ 站着不开枪
   P1-4 逐帧固定比例插值（FOV / 枪口光 / 头部回正）随刷新率变化
   P1-5 任务定时器不随 abort()/重新部署取消，会污染下一局
   P1-6 暂停菜单 / 战术地图下识别仍在全速推进
   P1-7 report() 死分支（小队永不能先敌发现）、点射逻辑被 fireCd 分支屏蔽
   用法： node tools/p1-test.mjs
   ============================================================ */
import { Suite } from './harness.mjs';

const suite = new Suite('p1-test');
const server = await suite.serve({ port: 8216 });
const browser = await suite.launch({
  headless: 'shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await suite.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => suite.check(name, ok, detail);

await page.goto('http://127.0.0.1:8216/?deploy=1&test=1', { waitUntil: 'load' });
await wait(2600);
await page.evaluate(() => { window.__game.testMode = true; });

/* ============================================================
   P1-1 射速与致盲时长
   ============================================================ */
const t1 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  p.active = 'primary';
  p.fireCd = 0; p.reloading = 0; p.blind = 0;
  p.mag.primary = 5000; p.reserve.primary = 5000;
  g.input.keys.clear();
  const before = g.stats.shots;
  g.input.lmb = true;
  for (let i = 0; i < 90; i++) g.advance(1 / 60, 1 / 60);   // 1.5s 固定步长
  g.input.lmb = false;

  /* 致盲时长：blind=4，推进整整 1 秒 */
  p.blind = 4;
  const blindBefore = p.blind;
  for (let i = 0; i < 60; i++) g.advance(1 / 60, 1 / 60);
  return {
    shots: g.stats.shots - before,
    blindBefore,
    blindAfter: +p.blind.toFixed(3),
    rpm: p.primaryDef.rpm,
  };
});
/* 标称 640rpm ⇒ 1.5s 应为 16 发；逐帧量化后为 15 发。
   双重递减时是 30 发，所以上限取 18 即可把 bug 卡住。 */
check('P1-1 射速不再翻倍（90 帧 @640rpm 应 ≈15 发，不再是 30 发）',
  t1.shots <= 18 && t1.shots >= 13,
  '标称 ' + t1.rpm + 'rpm，1.5s 实测 ' + t1.shots + ' 发（修前 30 发）');
check('P1-1 闪光弹致盲时长不再砍半（blind 4 → 1 秒后应剩 3，而非 2）',
  t1.blindAfter > 2.5,
  'blind ' + t1.blindBefore + ' → ' + t1.blindAfter + '（修前约 2.0）');

/* ============================================================
   P1-2 斜向移动的速度读数
   ============================================================ */
const t2 = await page.evaluate(() => {
  const g = window.__game;
  const a = g.player;
  const sp = g.world.spawns.player;
  g.input.lmb = false;
  g.input.keys.clear();
  /* 直接把 moveDir 按斜向调用：fx=+1, fz=-1。修前 vel 恒为 0。 */
  a.pos.x = sp.x; a.pos.z = sp.z;
  a.moveDir(1, -1, 3.1, 1 / 60);
  const diagVel = +a.vel.toFixed(3);
  /* 再跑一段真实输入（W+D），确认整条链路都正常 */
  a.pos.x = sp.x; a.pos.z = sp.z; a.yaw = sp.yaw; a.pitch = 0;
  g.input.keys.add('KeyW'); g.input.keys.add('KeyD');
  let maxVel = 0;
  for (let i = 0; i < 30; i++) { g.advance(1 / 60, 1 / 60); maxVel = Math.max(maxVel, a.vel); }
  g.input.keys.clear();
  return { diagVel, maxVel: +maxVel.toFixed(3) };
});
check('P1-2 斜向 moveDir 的速度读数不再为 0', t2.diagVel > 0.5,
  'moveDir(1,-1,3.1) ⇒ vel=' + t2.diagVel + ' m/s（修前 0）');
check('P1-2 真实 W+D 斜向移动速度读数正常', t2.maxVel > 0.5,
  '峰值 vel=' + t2.maxVel + ' m/s（修前 ≈0）');

/* ============================================================
   P1-3 掩体不可达：不得每帧全量 A*，且必须仍然开火
   ============================================================ */
const t3 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  const s = g.suspects.find((x) => x.alive);
  s.pos.x = p.pos.x; s.pos.z = p.pos.z - 8;
  s.hp = s.maxHp; s.morale = 1; s.blind = 0;
  s.state = 'engage'; s.alerted = true; s.awareness = 1;
  s.target = p; s.seenTarget = p;
  /* 故意给一个导航网格上不存在的掩体，并把重新找掩体的计时器推远 */
  s.coverPos = { x: 9999, z: 9999 };
  s.coverTimer = 99;
  s.fireCd = 0; s.path = null; s.pathAge = 0; s.burstLeft = 4;

  let setPathCalls = 0;
  s.setPath = function () { setPathCalls++; return null; };   // 强制失败
  let shots = 0;
  const origShoot = s.shootAt.bind(s);
  s.shootAt = function (...args) { shots++; return origShoot(...args); };

  for (let i = 0; i < 120; i++) {                              // 2 秒
    s.target = p; s.seenTarget = p; s.awareness = 1; s.state = 'engage';
    s.pos.x = p.pos.x; s.pos.z = p.pos.z - 8;                  // 钉在可见位置
    s.update(1 / 60);
  }
  return { setPathCalls, shots, coverPos: s.coverPos };
});
check('P1-3 掩体不可达时不再每帧触发全量 A*',
  t3.setPathCalls <= 10,
  '120 帧内 setPath 调用 ' + t3.setPathCalls + ' 次（修前 120 次）');
check('P1-3 掩体不可达的嫌疑人仍然会开火（不再被 return 跳过）',
  t3.shots > 0,
  '120 帧内开火 ' + t3.shots + ' 次（修前 0 次）');

/* ============================================================
   P1-4 帧率无关：同样的时间跨度，60fps 与 144fps 结果应一致
   ============================================================ */
const t4 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  const cam = g.camera;
  const SPAN = 0.1;   // 取较短跨度，否则两者都会完全收敛而看不出差别

  /* 关键：两种帧率必须覆盖「完全相同的模拟时长」。
     若按 n = round(SPAN*fps) 取整，144fps 会得到 14 步 × 1/144 = 0.0972s，
     比 60fps 的 0.1s 短 2.8%，指数衰减自然会差一点 —— 那是测试的错，不是代码的错。
     这里固定步数后把 dt 摊成 SPAN/n，保证总时长严格相等。 */
  const stepsFor = (fps) => Math.max(1, Math.round(SPAN * fps));

  const runFov = (fps) => {
    cam.fov = 72;
    const dt = SPAN / stepsFor(fps);
    for (let i = 0; i < stepsFor(fps); i++) {
      p.stance = 'sprint'; p.ads = 0; p.moving = 0;
      p.applyCamera(cam, dt);
    }
    return cam.fov;
  };
  const fov60 = runFov(60), fov144 = runFov(144);

  const runMuzzle = (fps, span) => {
    const fx = g.effects;
    fx.muzzleLight.intensity = 100;
    fx.muzzleTimer = 999;                 // 绕开计时器归零，只看衰减
    const n = Math.max(1, Math.round(span * fps));
    const dt = span / n;
    for (let i = 0; i < n; i++) fx.update(dt);
    const v = fx.muzzleLight.intensity;
    fx.muzzleTimer = 0; fx.muzzleLight.intensity = 0;
    return v;
  };
  const mz60 = runMuzzle(60, 0.1), mz144 = runMuzzle(144, 0.1);

  const runHead = (fps) => {
    const m = g.squad.find((x) => x.alive) || g.squad[0];
    const SPAN_H = 0.5;
    const n = Math.max(1, Math.round(SPAN_H * fps));
    const dt = SPAN_H / n;
    m.parts.head.rotation.x = 0.3; m.parts.head.rotation.z = 0.3;
    for (let i = 0; i < n; i++) { m.blind = 0; m.animate(dt); }
    return m.parts.head.rotation.x;
  };
  const h60 = runHead(60), h144 = runHead(144);

  return {
    fov60: +fov60.toFixed(4), fov144: +fov144.toFixed(4),
    mz60: +mz60.toFixed(4), mz144: +mz144.toFixed(4),
    h60: +h60.toFixed(5), h144: +h144.toFixed(5),
  };
});
check('P1-4 相机 FOV 过渡与刷新率无关',
  Math.abs(t4.fov60 - t4.fov144) < 0.05,
  '0.1s 后 60fps=' + t4.fov60 + ' / 144fps=' + t4.fov144 +
  '（逐帧固定比例时实测 60fps=75.21 / 144fps=77.00）');
check('P1-4 枪口闪光衰减与刷新率无关',
  Math.abs(t4.mz60 - t4.mz144) < Math.max(0.05, t4.mz60 * 0.05),
  '0.1s 后 60fps=' + t4.mz60 + ' / 144fps=' + t4.mz144);
check('P1-4 头部回正与刷新率无关',
  Math.abs(t4.h60 - t4.h144) < 0.005,
  '0.5s 后 60fps=' + t4.h60 + ' / 144fps=' + t4.h144);

/* ============================================================
   P1-5 任务定时器必须随 abort()/重新部署取消
   ------------------------------------------------------------
   注意：此处刻意用「对照 + 分段」的结构，原因有两个 ——
     1) 对照组：先证明这个 headless 环境里 3.2s 的裸 setTimeout 确实会触发。
        否则「新一局没被结束」可能只是定时器压根没跑，属于假绿。
     2) 分段：把「造成阵亡」与「中止并重新部署」放进两次独立的 evaluate。
        若三件事挤在同一个同步块里，旧实现的延时回调不会真正生效，
        这条断言就会在缺陷代码上误判为通过（已实测）。
   ============================================================ */
const t5a = await page.evaluate(() => {
  const g = window.__game;
  g.deploy(g.loadout);
  g.testMode = true;
  g.raiseAlarm('测试');
  return { tracked: g._timers ? g._timers.size : -1 };
});
check('P1-5 任务定时器被登记（raiseAlarm 至少挂一个）', t5a.tracked > 0,
  '_timers.size=' + t5a.tracked + '（修前没有这套机制）');

const t5b = await page.evaluate(() => {
  const g = window.__game;
  /* 让队长阵亡：这会排一个 3.2s 后 finishMission(false) 的回调 */
  g.player.takeDamage(9999, null);
  return { pending: g._timers.size, failed: g.failed, state: g.state };
});
check('P1-5 阵亡后确实排入了延时结算回调', t5b.pending > 0,
  '_timers.size=' + t5b.pending);

await page.evaluate(() => {
  const g = window.__game;
  g.abort();
  g.deploy(g.loadout);
  g.testMode = false;                 // 用真实主循环等着，看旧回调会不会生效
});
/* 对照组安排在等待窗口之内：证明这段时间里页面的 setTimeout 确实在跑 */
await page.evaluate(() => {
  window.__p5control = 0;
  setTimeout(() => { window.__p5control++; }, 1000);
});
await wait(4200);                     // 超过 3.2s，旧回调本该已触发
const t5c = await page.evaluate(() => {
  const g = window.__game;
  const debriefShown = !document.getElementById('screen-debrief').classList.contains('hidden');
  return { state: g.state, timers: g._timers.size, control: window.__p5control, debriefShown };
});
check('P1-5 对照组：环境里的 1s 定时器确实会触发（防止假绿）',
  t5c.control === 1,
  '对照定时器触发次数=' + t5c.control + '（必须为 1）');
/* 注意观察的是 state 而不是 failed：
   deploy() 会把 failed 复位，而旧回调走的是 finishMission(false)，
   它并不改 failed —— 它直接把新一局 state 置为 'debrief' 并弹出战果面板。 */
check('P1-5 中止并重新部署后，上一局的结算回调不得强制结束新一局',
  t5c.state === 'play' && t5c.debriefShown === false,
  '4.2s 后新一局 state=' + t5c.state + '，战果面板可见=' + t5c.debriefShown +
  '（修前会被旧回调直接推进到 debrief）');
check('P1-5 重新部署后定时器集合已清空', t5c.timers === 0, '_timers.size=' + t5c.timers);

/* ============================================================
   P1-6 暂停菜单 / 战术地图下识别必须冻结
   ============================================================ */
const t6 = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  g.testMode = true;
  const s = g.suspects.find((x) => x.alive);
  s.ident = 0; s.identified = false; s.seen = false;
  p.pos.x = 0; p.pos.z = 0; p.yaw = 0; p.pitch = 0; p.ads = 0;
  s.pos.x = 0; s.pos.z = -8; s.y = 0;
  g.suspects.forEach((o) => { if (o !== s) { o.pos.x = 900; o.pos.z = 900; } });

  const step = (n, opts) => {
    g.paused = !!opts.paused;
    if (opts.tacmap) { if (!g.tacmap.open) g.toggleTacMap(); }
    else if (g.tacmap.open) g.toggleTacMap();
    for (let i = 0; i < n; i++) g.advance(1 / 60, 1 / 60);
  };

  /* 正常态：应当增长 */
  s.ident = 0;
  step(30, {});
  const normal = +s.ident.toFixed(4);

  /* 暂停菜单：必须冻结。先把 ident 压回低位，
     否则一旦涨到 1.0 上限，「没涨」和「涨满被截断」就分不出来了。 */
  s.ident = 0.3;
  const beforePause = s.ident;
  step(60, { paused: true });
  const afterPause = +s.ident.toFixed(4);

  /* 战术地图打开：必须冻结（同样先压回低位） */
  g.paused = false;
  s.ident = 0.3;
  if (!g.tacmap.open) g.toggleTacMap();
  const beforeMap = s.ident;
  for (let i = 0; i < 60; i++) g.advance(1 / 60, 1 / 60);
  const afterMap = +s.ident.toFixed(4);

  if (g.tacmap.open) g.toggleTacMap();
  g.paused = false;
  return { normal, beforePause: +beforePause.toFixed(4), afterPause, beforeMap: +beforeMap.toFixed(4), afterMap };
});
check('P1-6 正常游玩时识别会推进（前置条件成立）', t6.normal > 0.05,
  '30 帧后 ident=' + t6.normal);
check('P1-6 暂停菜单下识别不再继续推进',
  Math.abs(t6.afterPause - t6.beforePause) < 1e-6,
  'ident ' + t6.beforePause + ' → ' + t6.afterPause + '（修前会继续涨）');
check('P1-6 战术地图打开时识别不再继续推进',
  Math.abs(t6.afterMap - t6.beforeMap) < 1e-6,
  'ident ' + t6.beforeMap + ' → ' + t6.afterMap);

/* ============================================================
   P1-7 小队先敌发现 + 点射节奏
   ============================================================ */
const t7a = await page.evaluate(() => {
  const g = window.__game;
  const m = g.squad.find((x) => x.alive);
  const s = g.suspects.find((x) => x.alive);
  s.seen = false; s.identified = false; s.ident = 0;
  s.pos.x = m.pos.x + 6; s.pos.z = m.pos.z;
  m.reportCd = 0;
  /* 直接调用 report()：修前 `if (!target.seen) return;` 会让这一支永远不可达 */
  let threw = null;
  try { m.report(s); } catch (e) { threw = String(e && e.message ? e.message : e); }
  return { seen: s.seen, reportCd: m.reportCd, threw };
});
check('P1-7 report() 能标记「小队先敌发现」（未识别接触）',
  t7a.seen === true && t7a.threw === null,
  'target.seen=' + t7a.seen + (t7a.threw ? ' 抛异常: ' + t7a.threw : '') + '（修前恒为 false）');

const t7b = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  /* 隔离：只留这一个嫌疑人 + 玩家，并关掉小队火力，否则小队会把目标打死/劝降，
     交火中断会污染「点射节奏」的测量。 */
  g.weaponsFree = false;
  g.squad.forEach((m) => { m.pos.x = 900; m.pos.z = 900; });
  g.suspects.forEach((o, i) => { if (o !== g.suspects[0]) { o.pos.x = 900; o.pos.z = 900 + i; } });
  const s = g.suspects.find((x) => x.alive);
  s.hp = s.maxHp; s.morale = 1; s.blind = 0;
  s.state = 'engage'; s.alerted = true; s.awareness = 1;
  s.fireCd = 0; s.burstLeft = 4; s.burstGap = 0.8;
  /* 玩家固定在 8m 外且不掉血：否则目标阵亡会让交火中断 */
  p.pos.x = 0; p.pos.z = 0;
  s.pos.x = 0; s.pos.z = -8;

  const times = [];
  const origShoot = s.shootAt.bind(s);
  let recording = false;
  let frame = 0;
  s.shootAt = function (...args) { if (recording) times.push(frame); return origShoot(...args); };

  const tick = () => {
    s.target = p; s.seenTarget = p; s.awareness = 1; s.state = 'engage';
    s.surrendered = false; s.detained = false;
    s.hp = s.maxHp; s.morale = 1; s.blind = 0;
    p.hp = p.maxHp; p.alive = true;
    s.pos.x = 0; s.pos.z = -8;
    s.update(1 / 60);
  };

  for (let i = 0; i < 60; i++, frame++) tick();      // 1s 预热，丢掉起始的半个点射
  recording = true;
  for (let i = 0; i < 60 * 10; i++, frame++) tick(); // 记录 10s

  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 60);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const burstSizes = [];
  let run = 1;
  for (const gp of gaps) {
    if (gp < 0.3) run++; else { burstSizes.push(run); run = 1; }
  }
  if (burstSizes.length) burstSizes.push(run);       // 末尾未结束的一轮也计入
  return { shots: times.length, maxGap: +maxGap.toFixed(3), burstSizes };
});
check('P1-7 点射之间存在停顿（旧实现是恒定 0.11s 的节拍器）',
  t7b.maxGap > 0.4,
  '10s 内 ' + t7b.shots + ' 发，最大间隔 ' + t7b.maxGap + 's（修前恒为 ~0.11s）');
/* 预热已丢掉起始的半个点射；末尾那一轮可能被窗口截断，故允许一个例外 */
const inRange = t7b.burstSizes.filter((n) => n >= 3 && n <= 5).length;
check('P1-7 点射长度落在设计的 3~5 发',
  t7b.burstSizes.length >= 3 && inRange >= t7b.burstSizes.length - 1,
  '共 ' + t7b.burstSizes.length + ' 轮，各轮发数=' + JSON.stringify(t7b.burstSizes.slice(0, 10)));

await suite.finish();
