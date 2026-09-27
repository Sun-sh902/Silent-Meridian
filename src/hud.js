/* ============================================================
   hud.js — 平视显示：目标卡、罗盘、小队面板、小地图、日志
   ============================================================ */
import { OBJECTIVES, ORDER_NAMES, DIRECTIONS, MAP_COLORS } from './data.js';
import { clamp } from './geom.js';
import { canvasDpr, watchResize } from './canvasfit.js';
import { LabelPlacer, measure } from './maplabel.js';
import { feel } from './feel.js';

const $ = (s) => document.querySelector(s);

export class HUD {
  constructor(game) {
    this.game = game;
    this.el = {
      root: $('#hud'),
      objectives: $('#objective-list'),
      clock: $('#clock'),
      alert: $('#alert-state'),
      idCount: $('#id-count'),
      civCount: $('#civ-count'),
      compass: $('#compass'),
      bearingText: $('#bearing-text'),
      bearingDeg: $('#bearing-deg'),
      squadList: $('#squad-list'),
      orderName: $('#order-name'),
      commandBar: $('#command-bar'),
      wpName: $('#wp-name'),
      wpMag: $('#wp-mag'),
      wpReserve: $('#wp-reserve'),
      wpAmmo: $('.wp-ammo'),
      wpMode: $('#wp-mode'),
      wpGadget: $('#wp-gadget'),
      wpReload: $('#wp-reload'),
      prompt: $('#prompt'),
      promptText: $('#prompt-text'),
      targetCard: $('#target-card'),
      tcClass: $('#tc-class'),
      tcRange: $('#tc-range'),
      tcIdent: $('#tc-ident'),
      tcNote: $('#tc-note'),
      observeRing: $('#observe-ring'),
      observeFg: $('#observe-ring .fg'),
      observeBanner: $('#observe-banner'),
      reticle: $('#reticle'),
      hitmarker: $('#hitmarker'),
      subtitle: $('#subtitle'),
      log: $('#log'),
      radio: $('#radio-feed'),
      minimap: $('#minimap'),
      cursorHint: $('#cursor-hint'),
      damage: $('#damage-flash'),
      grade: $('#grade'),
      whiteout: $('#whiteout'),   // 缓存：flash() 原本每次调用都重新 getElementById
    };
    this.ctxCompass = this.el.compass.getContext('2d');
    this.ctxMini = this.el.minimap.getContext('2d');
    this.logItems = [];
    this.radioItems = [];
    this.subTimer = 0;
    this.hitTimer = 0;
    this.flashAlpha = 0;
    this.buildObjectives();
    this.buildSquad();
    this.markerCache = null;
    /* 小地图：静态建筑层离屏缓存 + 复用缓冲 + 标签避让（全部零分配） */
    this.miniStatic = null;
    this.miniStaticBounds = null;
    this.pt = { x: 0, y: 0 };            // 复用的坐标缓冲
    this.placer = new LabelPlacer(48);
    this.zoneItems = [];                 // 预计算的地名候选（含面积用于排序）
    this.miniRange = 46;
    this.drawnLabels = [];      // 本帧真正画出的地名（供 __mapDebug 回查）
    this.drawnN = 0;
    this.labelStats = { total: 0, drawn: 0, rejected: 0, edge: 0 };
    /* 逐帧写入缓存：只有值真的变化时才碰 DOM。
       实测（tools/perf-probe.mjs）此前每帧约 27 次 DOM 变更、55 次布局读取，
       其中绝大多数是把同一个字符串/类名重复写一遍 —— 每次都产生一条
       mutation record 并可能触发样式重算。 */
    this._w = Object.create(null);
    this._roster = [];                   // 复用的花名册缓冲，避免每帧展开分配
    this._intTick = 0;
    this._intCache = null;
    this.buildMiniStatic();
    this.buildZoneItems();
    /* 3. canvas 尺寸随布局变化重算（含浏览器缩放导致的 DPR 变化） */
    this.sizeWatch = watchResize(document.getElementById('hud') || document.body, () => this.onResize());
  }

  /* ------------------------------------------------------------
     写入缓存辅助：写入前先比对，相同则完全跳过（不产生 DOM 变更）
     ------------------------------------------------------------ */
  _text(key, el, val) {
    const s = String(val);
    if (this._w[key] === s) return;
    this._w[key] = s;
    el.textContent = s;
  }
  _width(key, el, pct) {
    const s = pct + '%';
    if (this._w[key] === s) return;
    this._w[key] = s;
    el.style.width = s;
  }
  /* classList.toggle 本身幂等（无变化则不产生 mutation），这里只做短路省掉调用开销 */
  _cls(key, el, name, on) {
    const k = key + '|' + name;
    if (this._w[k] === on) return;
    this._w[k] = on;
    el.classList.toggle(name, on);
  }
  /* 缓存的 canvas CSS 尺寸：由 drawMinimap 每帧写入一次，供 worldToMap 复用 */
  _syncCanvasSize() {
    const cv = this.el.minimap;
    this._W = cv.clientWidth || 1;
    this._H = cv.clientHeight || 1;
  }

  /* ------------------------------------------------------------
     静态建筑层：一次性烘焙到离屏画布（世界坐标 1:1，6 px/m）
     每帧只做一次旋转 drawImage，不再逐栋重画 ~200 个矩形
     ------------------------------------------------------------ */
  buildMiniStatic() {
    const w = this.game.world;
    if (!w || !w.grid || this.miniStatic) return;
    const SPP = 6;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of w.grid.boxes) {
      if (b.max.y < 1.2) continue;
      if (b.min.x < x0) x0 = b.min.x;
      if (b.max.x > x1) x1 = b.max.x;
      if (b.min.z < z0) z0 = b.min.z;
      if (b.max.z > z1) z1 = b.max.z;
    }
    if (!(x1 > x0)) return;
    x0 -= 4; z0 -= 4; x1 += 4; z1 += 4;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round((x1 - x0) * SPP));
    cv.height = Math.max(1, Math.round((z1 - z0) * SPP));
    const g = cv.getContext('2d');
    g.setTransform(SPP, 0, 0, SPP, -x0 * SPP, -z0 * SPP);   // 之后直接用世界米坐标
    g.fillStyle = 'rgba(120,160,180,.18)';
    g.strokeStyle = 'rgba(140,190,210,.30)';
    g.lineWidth = 1.2 / SPP;
    for (const b of w.grid.boxes) {
      if (b.max.y < 1.2) continue;
      const bw = b.max.x - b.min.x, bh = b.max.z - b.min.z;
      g.fillRect(b.min.x, b.min.z, bw, bh);
      g.strokeRect(b.min.x, b.min.z, bw, bh);
    }
    this.miniStatic = cv;
    this.miniStaticBounds = { x0, z0, x1, z1 };
  }

  /* 地名候选：面积大的先放，小房间（办公室/调度室）自然在碰撞中被挤掉 */
  buildZoneItems() {
    const w = this.game.world;
    if (!w || !w.zones) return;
    this.zoneItems.length = 0;
    for (const z of w.zones) {
      const area = (z.x1 - z.x0) * (z.z1 - z.z0);
      this.zoneItems.push({
        name: z.short || z.label, label: z.label, kind: z.kind, area,
        x: (z.x0 + z.x1) / 2, z: (z.z0 + z.z1) / 2,
        radius: Math.min(z.x1 - z.x0, z.z1 - z.z0) / 2,
        dist: 0, key: 0,
      });
    }
    /* 排序键缓存比较器：只创建一次，逐帧复用，避免 GC */
    this._zoneCmp = (a, b) => a.key - b.key;
  }

  /* ------------------------------------------------------------
     世界坐标 → 小地图像素坐标
     ① 平移到玩家为原点 → ② 绕原点旋转 +yaw → ③ 缩放 k → ④ 平移到画布中心
     （旋转中心 = 玩家自身；角度每帧由绝对 yaw 重算，无累积漂移）
     ------------------------------------------------------------ */
  worldToMap(wx, wz, out) {
    const p = this.game.player;
    /* 尺寸走缓存：drawMinimap 每帧只读一次布局并写入 _W/_H。
       此前这里每次调用都读 clientWidth/clientHeight，而本函数每帧被调用
       约 25 次（任务点 + 事件 + 全部演员 + 地名），是每帧 50+ 次布局读取的主因。 */
    if (!this._W || !this._H) this._syncCanvasSize();
    const W = this._W, H = this._H;
    /* 角度仍用实时 yaw，不依赖上一帧缓存
       （否则外部改完 yaw 立刻查询会拿到旧角度） */
    const k = (W / 2) / this.miniRange;
    const C = Math.cos(p.yaw), S = Math.sin(p.yaw);
    const dx = wx - p.pos.x, dz = wz - p.pos.z;
    out = out || this.pt;
    out.x = W / 2 + k * (C * dx - S * dz);
    out.y = H / 2 + k * (S * dx + C * dz);
    return out;
  }

  onResize() {
    // 尺寸变化时立即重绘两块 canvas，避免出现拉伸的旧帧
    if (this.game && this.game.world && this.game.player) {
      this.updateCompass(this.game);
      this.drawMinimap(this.game);
    }
  }

  /* ---------------- 静态结构 ---------------- */
  buildObjectives() {
    this.el.objectives.innerHTML = '';
    for (const o of OBJECTIVES) {
      const li = document.createElement('li');
      li.dataset.id = o.id;
      li.innerHTML = `<i class="box"></i><div><b>${o.label}</b><span class="sub">${o.sub}</span></div>`;
      this.el.objectives.appendChild(li);
    }
  }

  buildSquad() {
    this.el.squadList.innerHTML = '';
    this.squadEls = {};
    const roster = [this.game.player, ...this.game.squad];
    roster.forEach((a, i) => {
      if (!a) return;
      const d = document.createElement('div');
      d.className = 'sq';
      d.innerHTML = `
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="nm"><b>${a.callsign}</b><span>${a.kind === 'player' ? 'SQUAD LEADER' : (a.tag || 'RIFLEMAN')}</span></span>
        <span class="st">待命</span>
        <span class="hp" style="grid-column:2/4"><i style="width:100%"></i></span>`;
      this.el.squadList.appendChild(d);
      this.squadEls[a.id] = { root: d, hp: d.querySelector('.hp i'), st: d.querySelector('.st') };
    });
  }

  /* ---------------- 每帧 ---------------- */
  update(dt, game) {
    const p = game.player;
    this.updateObjectives(game);
    this.updateStatus(game);
    this.updateSquad(game);
    this.updateWeapon(game);
    this.updateTarget(game);
    this.updateCompass(game);
    this.drawMinimap(game);
    this.el.observeBanner.classList.toggle('hidden', !game.tacticalPause);
    this.setCursorMode(!!game.cursorMode);
    this.el.reticle.classList.toggle('ads', p.ads > 0.5);
    const ringR = 42 * 2 * Math.PI;
    /* stroke-dasharray 已是 ui.css 里的静态值（264），不必每帧重写；
       只有 dashoffset 随识别进度连续变化。 */
    const off = ringR * (1 - (game.observeTarget ? game.observeTarget.ident : 0));
    if (this._w.ringOff !== off) { this._w.ringOff = off; this.el.observeFg.style.strokeDashoffset = off; }
    this.el.observeRing.classList.toggle('on', !!game.observeTarget && game.observeTarget.ident < 1);

    /* 交互提示：findInteraction 会遍历全部演员并构造对象/模板串，
       不必每帧算一次 —— 每 4 帧刷新一次，手感上察觉不到。
       注意 doInteract() 仍会在按键时实时调用一次，保证动作与提示一致。 */
    if ((this._intTick++ & 3) === 0) this._intCache = p.findInteraction();
    const it = this._intCache;
    if (it) {
      this._cls('prompt', this.el.prompt, 'hidden', false);
      this._text('promptText', this.el.promptText, it.label);
    } else {
      this._cls('prompt', this.el.prompt, 'hidden', true);
    }

    // 字幕 / 日志计时
    if (this.subTimer > 0) {
      this.subTimer -= dt;
      if (this.subTimer <= 0) this.el.subtitle.classList.remove('on');
    }
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.el.hitmarker.classList.remove('show');
    }
  }

  setCursorMode(on) {
    if (!this.el.cursorHint) return;
    /* 此前这个方法是每帧被调用的，却无条件重写 innerHTML ——
       等于每帧做一次完整的 HTML 解析 + 子树替换，是单帧 DOM 变更的最大来源。
       只在模式真正切换时更新。 */
    if (this._w.cursorMode === on) return;
    this._w.cursorMode = on;
    this.el.cursorHint.classList.toggle('on', on);
    this.el.cursorHint.innerHTML = on
      ? '鼠标已释放 — 可点击指令按钮（点击画面恢复视角）'
      : '按 <b>Alt</b> 释放鼠标，即可点击上面的指令按钮';
  }

  updateObjectives(game) {
    for (const li of this.el.objectives.children) {
      const st = game.objectiveState[li.dataset.id];
      const k = 'obj:' + li.dataset.id;
      if (this._w[k] === st) continue;      // 状态没变就整项跳过
      this._w[k] = st;
      li.className = st === 'done' ? 'done' : st === 'failed' ? 'failed' : st === 'active' ? 'active' : '';
      li.querySelector('.box').textContent = st === 'done' ? '✓' : st === 'failed' ? '✕' : '';
    }
  }

  updateStatus(game) {
    this._text('clock', this.el.clock, game.clockString());
    const a = game.alertLevel();
    this._text('alert', this.el.alert, a.text);
    if (this._w.alertCls !== a.cls) { this._w.alertCls = a.cls; this.el.alert.className = a.cls; }
    /* 计数循环取代 filter()：原先每帧两次数组分配 */
    let ided = 0;
    for (const x of game.actors) if (x.kind === 'suspect' && x.identified) ided++;
    let safe = 0;
    for (const c of game.civilians) if (c.safe) safe++;
    this._text('idCount', this.el.idCount, ided + ' / ' + game.suspects.length);
    this._text('civCount', this.el.civCount, safe + ' / ' + game.civilians.length);
  }

  updateSquad(game) {
    const order = ORDER_NAMES[game.squadOrder] || ORDER_NAMES.follow;
    this._text('orderName', this.el.orderName,
      game.squadOrder === 'clear' && game.squadWaypoint ? `${order.cn} · 前往航点` : order.cn);
    for (const cmd of this.el.commandBar.children) {
      cmd.classList.toggle('active', cmd.dataset.cmd === game.squadOrder);
    }
    /* 复用同一个数组，避免每帧 [player, ...squad] 的展开分配 */
    const roster = this._roster;
    roster.length = 0;
    roster.push(game.player);
    for (const m of game.squad) roster.push(m);
    for (const a of roster) {
      const e = this.squadEls[a.id];
      if (!e) continue;
      const pct = Math.round(clamp(a.hp / a.maxHp, 0, 1) * 100);
      this._width('hp:' + a.id, e.hp, pct);
      this._cls('sq:' + a.id, e.root, 'down', !a.alive);
      this._cls('sq:' + a.id, e.root, 'hurt', a.alive && pct < 60);
      this._cls('sq:' + a.id, e.root, 'acting', a === game.actingMember);
      let st = '待命';
      if (!a.alive) st = '失去行动能力';
      else if (a.blind > 0) st = '失能';
      else if (a.kind === 'player') st = a.stance === 'sprint' ? '疾行' : a.stance === 'sneak' ? '潜行' : '移动中';
      else if (a.vel > 0.4) st = '推进中';
      if (a.aimTarget) st = '交战中';
      this._text('sqst:' + a.id, e.st, st);
    }
  }

  updateWeapon(game) {
    const p = game.player;
    const d = p.def;
    this._text('wpName', this.el.wpName, d.short);
    this._text('wpMag', this.el.wpMag, p.mag[p.active]);
    this._text('wpReserve', this.el.wpReserve, p.reserve[p.active]);
    this._cls('wpAmmo', this.el.wpAmmo, 'low', p.mag[p.active] <= Math.max(2, d.mag * 0.25));
    this._text('wpMode', this.el.wpMode, d.mode);
    const g = p.gadgetDef;
    this._text('wpGadget', this.el.wpGadget, `${g.short} ×${p.gadgetCount}`);
    const loading = p.reloading > 0;
    this._cls('wpReload', this.el.wpReload, 'hidden', !loading);
    /* 只在可见时更新百分比文本（原先隐藏状态下也每帧写一次） */
    if (loading) {
      this._text('wpReloadTxt', this.el.wpReload,
        `换弹中… ${Math.max(0, (p.reloading / d.reload) * 100).toFixed(0)}%`);
    }
  }

  updateTarget(game) {
    const t = game.observeTarget;
    // 倒地的队友仍要显示状态（可急救），倒地的敌人/平民不再显示
    if (!t || (!t.alive && t.kind !== 'squad')) {
      this._cls('tc', this.el.targetCard, 'hidden', true);
      return;
    }
    this._cls('tc', this.el.targetCard, 'hidden', false);
    const range = Math.round(Math.hypot(t.pos.x - game.player.pos.x, t.pos.z - game.player.pos.z));
    this._text('tcRange', this.el.tcRange, range + ' m');
    this._width('tcIdent', this.el.tcIdent, (t.ident * 100).toFixed(0));

    /* 变体类：原先用 `className = ''` 清空再 add —— 即便结果完全一样，
       每帧都会产生一次 class 属性变更。改为只增删差异项。 */
    let variant = '';
    let cls = '', note = '';
    if (t.ident >= 0.8) {
      if (t.kind === 'suspect') {
        variant = 'armed';
        cls = t.surrendered ? '已投降嫌疑人' : '武装嫌疑人';
        note = t.surrendered ? '可上前拘押（E）' : (t.name || '');
      } else if (t.kind === 'civilian') {
        variant = 'civilian';
        cls = '平民 · 非战斗人员';
        note = '误伤将导致任务失败 · E 护送撤离';
      } else {
        variant = 'friendly';
        cls = t.callsign || '警备人员';
        note = t.alive
          ? `友军 · ${t.tag || '警备人员'}（不会受到你的伤害）`
          : '失去行动能力 · 需要急救（E）';
      }
    } else if (t.ident >= 0.35) {
      cls = '人员接触 · 身份不明';
      note = '持续观察以确认目标 · HOLD TO IDENTIFY';
    } else {
      cls = 'UNKNOWN CONTACT';
      note = '疑似活动 · 需要观察';
    }
    if (this._w.tcVariant !== variant) {
      this._w.tcVariant = variant;
      const el = this.el.targetCard;
      el.classList.remove('armed', 'civilian', 'friendly');
      if (variant) el.classList.add(variant);
    }
    this._text('tcClass', this.el.tcClass, cls);
    this._text('tcNote', this.el.tcNote, note);
  }

  updateCompass(game) {
    const c = this.ctxCompass;
    const cv = this.el.compass;
    const cssW = cv.clientWidth;
    if (!cssW) return;                       // 元素被断点隐藏时不绘制
    /* backing store = CSS 尺寸 × DPR；绘制仍用 720×58 设计坐标 */
    const dpr = canvasDpr();
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssW * (58 / 720) * dpr));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const S = bw / 720;
    c.setTransform(S, 0, 0, S, 0, 0);
    const w = 720, h = 58;
    c.clearRect(0, 0, w, h);
    const yaw = game.player.yaw;
    const bearing = game.playerBearing();
    const span = 130; // 可视角度
    const pxPerDeg = w / span;

    // 刻度
    c.save();
    c.translate(w / 2, h);
    c.font = '500 11px ui-monospace, monospace';
    c.textAlign = 'center';
    for (let deg = -span / 2 - 20; deg <= span / 2 + 20; deg += 5) {
      const worldDeg = ((bearing + deg) % 360 + 360) % 360;
      const x = deg * pxPerDeg;
      const major = Math.abs(worldDeg % 45) < 0.5 || Math.abs(worldDeg % 45 - 45) < 0.5;
      const hh = major ? 17 : 9;
      c.strokeStyle = major ? 'rgba(200,230,240,.62)' : 'rgba(160,200,215,.26)';
      c.lineWidth = major ? 1.6 : 1;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, -hh); c.stroke();
      if (major) {
        c.fillStyle = 'rgba(200,230,240,.75)';
        const label = worldDeg === 0 ? 'N' : worldDeg === 90 ? 'E' : worldDeg === 180 ? 'S' : worldDeg === 270 ? 'W' : String(Math.round(worldDeg));
        c.fillText(label, x, -21);
      }
    }
    c.restore();

    // 标记
    const markers = [];
    for (const o of game.markerList()) markers.push(o);
    for (const m of markers) {
      const rel = ((m.bearing - bearing + 540) % 360) - 180;
      if (Math.abs(rel) > span / 2) continue;
      const x = w / 2 + rel * pxPerDeg;
      c.save();
      c.translate(x, 22);
      c.fillStyle = m.color;
      c.strokeStyle = m.color;
      if (m.shape === 'diamond') {
        c.beginPath(); c.moveTo(0, -6); c.lineTo(6, 0); c.lineTo(0, 6); c.lineTo(-6, 0); c.closePath(); c.fill();
      } else if (m.shape === 'triangle') {
        c.beginPath(); c.moveTo(0, -6); c.lineTo(5.5, 4); c.lineTo(-5.5, 4); c.closePath(); c.fill();
      } else {
        c.lineWidth = 1.6; c.beginPath(); c.arc(0, 0, 4.6, 0, 6.3); c.stroke();
      }
      if (m.label) {
        c.font = '600 9.5px ui-monospace, monospace';
        c.textAlign = 'center';
        c.fillStyle = m.color;
        c.fillText(m.label, 0, -11);
      }
      c.restore();
    }

    this.el.bearingText.textContent = bearingName(bearing);
    this.el.bearingDeg.textContent = String(Math.round(bearing)).padStart(3, '0');
  }

  drawMinimap(game) {
    const c = this.ctxMini;
    const cv = this.el.minimap;
    const cssW = cv.clientWidth, cssH = cv.clientHeight;
    if (!cssW || !cssH) return;              // 断点隐藏时不绘制
    const dpr = canvasDpr();
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);    // 之后按 CSS 像素绘制
    const W = cssW, H = cssH;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(6,11,16,.85)';
    c.fillRect(0, 0, W, H);
    const p = game.player;
    const range = this.miniRange;
    const k = (W / 2) / range;
    /* 旋转用 +yaw：玩家右转时原本正前方的目标向左移动。
       （注意本项目 yaw 减小 = 右转，见 player.look()） */
    const C = Math.cos(p.yaw), S = Math.sin(p.yaw);
    this._C = C; this._S = S; this._k = k; this._W = W; this._H = H;

    /* ---- 静态建筑层：一次 drawImage 完成旋转 ----
       矩阵等价于 平移(-p) → 旋转(+yaw) → 缩放(k) → 平移(中心) */
    if (!this.miniStatic) this.buildMiniStatic();
    if (this.miniStatic) {
      const b = this.miniStaticBounds;
      c.save();
      c.transform(k * C, k * S, -k * S, k * C,
        W / 2 - k * (C * p.pos.x - S * p.pos.z),
        H / 2 - k * (S * p.pos.x + C * p.pos.z));
      c.drawImage(this.miniStatic, b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0);
      c.restore();
    }
    // 任务点
    for (const key of ['manifest', 'evidence', 'extract']) {
      const o = game.world.objectives[key];
      const done = game.objectiveState[key] === 'done';
      const active = game.objectiveState[key] === 'active' || (key === 'extract' && game.objectiveState.extract === 'active');
      if (done && key !== 'extract') continue;
      const m = this.worldToMap(o.x, o.z, this.pt);
      if (Math.hypot(m.x - W / 2, m.y - H / 2) > W / 2 - 6) continue;
      c.save();
      c.translate(m.x, m.y);
      c.strokeStyle = MAP_COLORS.objective; c.lineWidth = 1.6;
      c.rotate(Math.PI / 4);
      c.strokeRect(-4, -4, 8, 8);
      c.restore();
    }
    // 事件（黄点）
    for (const ev of game.mapEvents || []) {
      const age = game.missionTime - ev.t;
      if (age > 120) continue;
      const m = this.worldToMap(ev.x, ev.z, this.pt);
      if (m.x < 0 || m.x > W || m.y < 0 || m.y > H) continue;
      c.globalAlpha = age > 60 ? 0.35 : 0.85;
      c.fillStyle = MAP_COLORS.event;
      c.beginPath(); c.arc(m.x, m.y, 2.6, 0, 6.3); c.fill();
      c.globalAlpha = 1;
    }
    // 单位
    for (const a of game.actors) {
      if (a.safe || a === p) continue;        // 玩家由中心箭头单独绘制，避免蓝点+白三角重叠
      const known = a.kind === 'squad' || a.kind === 'civilian' ? true : a.seen;
      if (!known) continue;
      const m = this.worldToMap(a.pos.x, a.pos.z, this.pt);
      if (m.x < 2 || m.x > W - 2 || m.y < 2 || m.y > H - 2) continue;
      let col = MAP_COLORS.friendly;                       // 主角与队友 —— 蓝
      if (a.kind === 'suspect') col = a.identified ? MAP_COLORS.enemy : MAP_COLORS.unknown;
      else if (a.kind === 'civilian') col = MAP_COLORS.civilian;
      if (!a.alive) col = 'rgba(255,97,82,.55)';
      c.fillStyle = col;
      if (a.kind === 'suspect' && !a.identified) {
        c.beginPath(); c.arc(m.x, m.y, 3.4, 0, 6.3); c.strokeStyle = col; c.lineWidth = 1.4; c.stroke();
      } else {
        c.beginPath(); c.arc(m.x, m.y, 3.4, 0, 6.3); c.fill();
      }
    }
    /* ---- 视野扇形：角度取自真实相机水平 FOV，与准星严格一致 ---- */
    const cam = game.camera;
    const vfov = ((cam.fov || 72) * Math.PI) / 180;
    const half = Math.atan(Math.tan(vfov / 2) * (cam.aspect || 1));
    const coneR = Math.min(W, H) / 2 - 3;
    c.save();
    c.translate(W / 2, H / 2);
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, coneR, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.closePath();
    c.fillStyle = 'rgba(140,190,210,.10)';
    c.fill();
    c.strokeStyle = 'rgba(140,190,210,.22)';
    c.lineWidth = 1;
    c.stroke();
    c.restore();

    /* ---- 地名标签（水平、不随旋转；按面积优先 + 碰撞避让） ---- */
    const placer = this.placer;
    placer.reset();
    placer.reserve(W / 2 - 16, H / 2 - 16, 32, 32);        // 中心留给玩家图标
    const FONT = '600 12px "Helvetica Neue","PingFang SC",sans-serif';
    c.font = FONT;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    const visibleR = range * 0.96;
    const edgeR = Math.min(W, H) / 2 - 13;
    let edgeDrawn = 0;
    const items = this.zoneItems;
    const stats = this.labelStats;
    stats.total = items.length; stats.drawn = 0; stats.rejected = 0; stats.edge = 0;
    this.drawnN = 0;
    for (let i = 0; i < items.length; i++) {
      const z = items[i];
      z.dist = Math.hypot(z.x - p.pos.x, z.z - p.pos.z);
      z.key = z.dist - z.radius;             // 近处 / 大范围优先
    }
    if (this._zoneCmp) items.sort(this._zoneCmp);
    for (let i = 0; i < items.length; i++) {
      const z = items[i];
      const dist = z.dist;
      const m = this.worldToMap(z.x, z.z, this.pt);
      if (dist > visibleR) {
        /* 超出可视范围：收缩到边界画方向箭头，而不是丢掉或堆在角落 */
        if (dist > 200 || edgeDrawn >= 5) continue;
        const ox = m.x - W / 2, oy = m.y - H / 2;
        const l = Math.hypot(ox, oy) || 1;
        const ex = W / 2 + (ox / l) * edgeR, ey = H / 2 + (oy / l) * edgeR;
        c.save();
        c.translate(ex, ey);
        c.rotate(Math.atan2(oy, ox));
        c.fillStyle = z.kind === 'room' ? 'rgba(120,160,180,.4)' : 'rgba(150,200,220,.62)';
        c.beginPath(); c.moveTo(6, 0); c.lineTo(-4, 4.5); c.lineTo(-4, -4.5); c.closePath(); c.fill();
        c.restore();
        edgeDrawn++;
        stats.edge++;
        continue;
      }
      const tw = measure(c, FONT, z.name);
      const tx = m.x - tw / 2, ty = m.y - 6;
      if (tx < 2 || ty - 8 < 2 || tx + tw > W - 2 || ty + 8 > H - 2) continue;   // 越界不画
      if (!placer.tryPlace(tx - 3, ty - 8, tw + 6, 16)) { stats.rejected++; continue; }  // 重叠让位
      c.fillStyle = 'rgba(6,11,16,.62)';
      c.fillRect(tx - 3, ty - 8, tw + 6, 16);
      c.fillStyle = 'rgba(198,226,240,.94)';
      c.fillText(z.name, tx, ty);
      let d = this.drawnLabels[this.drawnN];
      if (!d) d = this.drawnLabels[this.drawnN] = { text: '', x: 0, y: 0, w: 0 };
      d.text = z.name; d.x = tx; d.y = ty; d.w = tw;
      this.drawnN++;
      stats.drawn++;
    }

    /* ---- 玩家：固定在中心，箭头恒朝上（玩家朝上模式） ---- */
    c.save();
    c.translate(W / 2, H / 2);
    c.fillStyle = MAP_COLORS.friendly;
    c.beginPath(); c.moveTo(0, -7); c.lineTo(5, 5.5); c.lineTo(0, 3); c.lineTo(-5, 5.5); c.closePath(); c.fill();
    c.strokeStyle = '#ffffff'; c.lineWidth = 1.2; c.stroke();
    c.restore();
  }

  /* ---------------- 反馈 ---------------- */
  hit(kill = false) {
    this.el.hitmarker.classList.remove('show');
    void this.el.hitmarker.offsetWidth;
    this.el.hitmarker.classList.toggle('kill', kill);
    this.el.hitmarker.classList.add('show');
    this.hitTimer = feel.feedback.hitmarkerTime;
  }

  flash(alpha = 0.85) {
    /* 4. 纯 CSS 合成层：只改 opacity（transform/opacity 由合成器处理），
       不写 background、不读像素、不动 #grade 的渐变+滤镜。 */
    const w = this.el.whiteout;
    if (!w) return;
    w.style.transition = 'none';
    w.style.opacity = String(Math.min(1, Math.max(0, alpha)));
    // 强制一次样式刷新后再启动过渡，保证从当前不透明度开始淡出
    void w.offsetWidth;
    w.style.transition = 'opacity .5s linear';
    w.style.opacity = '0';
  }

  damage() {
    this.el.damage.classList.add('hit');
    setTimeout(() => this.el.damage.classList.remove('hit'), 60);
    setTimeout(() => { this.el.damage.style.opacity = '0'; }, 220);
  }

  say(text, who, dur = 3.4) {
    this.el.subtitle.innerHTML = who ? `<b>${who}</b>：${text}` : text;
    this.el.subtitle.classList.add('on');
    this.subTimer = dur;
  }

  addLog(text, kind = '') {
    const d = document.createElement('div');
    d.className = 'log-item ' + kind;
    d.textContent = text;
    this.el.log.appendChild(d);
    this.logItems.push(d);
    if (this.logItems.length > 7) { const old = this.logItems.shift(); old.remove(); }
    setTimeout(() => {
      d.style.transition = 'opacity .5s, transform .5s';
      d.style.opacity = '0'; d.style.transform = 'translateX(14px)';
      setTimeout(() => { d.remove(); this.logItems = this.logItems.filter((x) => x !== d); }, 500);
    }, 6500);
  }

  radio(who, text) {
    const d = document.createElement('div');
    d.className = 'rd';
    d.innerHTML = `<div class="who">${who}</div><div class="what">${text}</div>`;
    this.el.radio.appendChild(d);
    requestAnimationFrame(() => d.classList.add('on'));
    this.radioItems.push(d);
    if (this.radioItems.length > 3) { const old = this.radioItems.shift(); old.remove(); }
    setTimeout(() => {
      d.classList.remove('on');
      setTimeout(() => { d.remove(); this.radioItems = this.radioItems.filter((x) => x !== d); }, 500);
    }, 5200);
  }
}

function bearingName(deg) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
