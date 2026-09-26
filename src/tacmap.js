/* ============================================================
   tacmap.js — 战术地图（Tab）：俯视规划、放置航点、下达指令
   ============================================================ */
import { clamp, dist2D } from './geom.js';
import { canvasDpr, watchResize } from './canvasfit.js';
import { MAP_COLORS } from './data.js';
import { LabelPlacer, measure } from './maplabel.js';

const EVENT_TTL = 120;   // 事件点存活时长（秒）
/* 字号固定为设计像素；因 render() 已 setTransform(dpr)，实际会按设备像素比放大，
   既不会被地图缩放拉伸，也不会在 HiDPI 上缩水，且始终 ≥12px。 */
const FONT_SM = '600 12px ui-monospace, monospace';
const FONT_MD = '600 12px "Helvetica Neue","PingFang SC",sans-serif';
const FONT_ZONE = '600 12px "Helvetica Neue","PingFang SC",sans-serif';

export class TacMap {
  constructor(game) {
    this.game = game;
    this.el = document.querySelector('#tacmap');
    this.canvas = document.querySelector('#tacmap-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.W = this.canvas.width;
    this.H = this.canvas.height;
    this.open = false;
    this.static = null;
    this.hoverWorld = null;
    /* 标签池 + 索引排序缓冲：全部预分配，逐帧复用（零 GC） */
    this._pool = [];
    this._ln = 0;
    this._idx = new Int32Array(96);
    this._key = new Float32Array(96);
    this._cmp = (a, b) => this._key[a] - this._key[b];
    this.placer = new LabelPlacer(96);
    /* 本帧真正画出的标签（供 __mapDebug 回查，逐帧复用不新建对象） */
    this.drawn = [];
    this.drawnN = 0;
    this.labelStats = { total: 0, drawn: 0, rejected: 0, offscreen: 0 };
    this.bounds = { x0: -80, x1: 80, z0: -72, z1: 56 };
    this.aspect = 1280 / 860;
    this.layout(1280, 860);

    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hoverWorld = this.toWorld(
        (e.clientX - r.left) * (this.W / r.width),
        (e.clientY - r.top) * (this.H / r.height));
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const w = this.toWorld(
        (e.clientX - r.left) * (this.W / r.width),
        (e.clientY - r.top) * (this.H / r.height));
      if (e.button === 0) this.game.issueClearAt(w.x, w.z, 'squad');
      else if (e.button === 2) this.game.setFocusMarker(w.x, w.z);
    });
    this.canvas.addEventListener('dblclick', () => this.game.clearWaypoints());

    // 3. 容器尺寸变化（拖动窗口 / 浏览器缩放 / 断点重排）时重新排布画布
    this.sizeWatch = watchResize(this.el.querySelector('.tm-frame') || this.el, () => {
      if (this.open) this.relayout();
    });
  }

  /** 按可用空间设定画布尺寸，保持世界比例不被拉伸 */
  layout(availW, availH) {
    const dpr = canvasDpr(2);
    let cssW = Math.max(320, Math.min(availW, availH * this.aspect));
    let cssH = cssW / this.aspect;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    const changed = this.canvas.width !== bw || this.canvas.height !== bh;
    this.canvas.width = bw;
    this.canvas.height = bh;
    /* 逻辑坐标统一用 CSS 像素；设备像素比通过 setTransform 施加，
       这样字号不会被 dpr 拉伸，HiDPI 下也不再缩成一半 */
    this.W = cssW;
    this.H = cssH;
    const pad = 26;
    const sx = (this.W - pad * 2) / (this.bounds.x1 - this.bounds.x0);
    const sz = (this.H - pad * 2) / (this.bounds.z1 - this.bounds.z0);
    this.scale = Math.min(sx, sz);
    this.ox = (this.W - (this.bounds.x1 - this.bounds.x0) * this.scale) / 2;
    this.oy = (this.H - (this.bounds.z1 - this.bounds.z0) * this.scale) / 2;
    this.dpr = dpr;
    if (changed) this.static = null;   // 只有尺寸真的变了才丢弃静态层
    return changed;
  }

  /** 按当前可用空间重新排布（窗口/缩放变化时调用） */
  relayout() {
    const frame = this.el.querySelector('.tm-frame');
    if (!frame || !frame.clientWidth || !frame.clientHeight) return;
    const head = this.el.querySelector('.tm-head');
    const foot = this.el.querySelector('.tm-foot');
    const availW = frame.clientWidth - 4;
    const availH = frame.clientHeight - (head ? head.offsetHeight : 0) - (foot ? foot.offsetHeight : 0) - 4;
    if (availW <= 40 || availH <= 40) return;
    this.layout(availW, availH);
    if (!this.static) this.buildStatic();
    this.render();
  }

  toMap(x, z) {
    return { x: this.ox + (x - this.bounds.x0) * this.scale, y: this.oy + (z - this.bounds.z0) * this.scale };
  }

  /** 收集一个标签候选（不含绘制），prio 越小越优先 */
  pushLabel(text, x, y, prio, font, color, dist) {
    let L = this._pool[this._ln];
    if (!L) L = this._pool[this._ln] = { text: '', x: 0, y: 0, prio: 0, font: '', color: '', dist: 0 };
    L.text = text; L.x = x; L.y = y; L.prio = prio; L.font = font; L.color = color; L.dist = dist;
    this._ln++;
  }

  /** 统一绘制标签：优先级 + 距离排序 → 边界裁剪 → 碰撞避让 → 底衬 + 水平文字 */
  drawLabels(g) {
    const n = this._ln;
    const stats = this.labelStats;
    stats.total = n; stats.drawn = 0; stats.rejected = 0; stats.offscreen = 0;
    this.drawnN = 0;
    if (!n) return;
    if (this._idx.length < n) { this._idx = new Int32Array(n + 32); this._key = new Float32Array(n + 32); }
    const idx = this._idx, key = this._key;
    for (let i = 0; i < n; i++) { idx[i] = i; key[i] = this._pool[i].prio * 1e6 + this._pool[i].dist; }
    const order = idx.subarray(0, n);
    order.sort(this._cmp);
    this.placer.reset();
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (let k = 0; k < n; k++) {
      const L = this._pool[order[k]];
      const tw = measure(g, L.font, L.text);
      const tx = L.x, ty = L.y;
      if (tx < 2 || ty - 7 < 2 || tx + tw > this.W - 2 || ty + 7 > this.H - 2) { stats.offscreen++; continue; }
      if (!this.placer.tryPlace(tx - 3, ty - 7, tw + 6, 14)) { stats.rejected++; continue; }
      g.font = L.font;
      g.fillStyle = 'rgba(6,12,17,.66)';
      g.fillRect(tx - 3, ty - 7, tw + 6, 14);
      g.fillStyle = L.color;
      g.fillText(L.text, tx, ty);
      let d = this.drawn[this.drawnN];
      if (!d) d = this.drawn[this.drawnN] = { text: '', x: 0, y: 0, w: 0, prio: 0 };
      d.text = L.text; d.x = tx; d.y = ty; d.w = tw; d.prio = L.prio;
      this.drawnN++;
      stats.drawn++;
    }
  }
  toWorld(mx, my) {
    return {
      x: this.bounds.x0 + (mx - this.ox) / this.scale,
      z: this.bounds.z0 + (my - this.oy) / this.scale,
    };
  }

  buildStatic() {
    const c = document.createElement('canvas');
    c.width = Math.round(this.W * this.dpr);
    c.height = Math.round(this.H * this.dpr);
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);   // 用逻辑像素绘制
    g.fillStyle = '#060c11';
    g.fillRect(0, 0, this.W, this.H);

    // 网格（10m）
    g.strokeStyle = 'rgba(90,130,150,.10)';
    g.lineWidth = 1;
    for (let x = Math.ceil(this.bounds.x0 / 10) * 10; x <= this.bounds.x1; x += 10) {
      const a = this.toMap(x, this.bounds.z0), b = this.toMap(x, this.bounds.z1);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    for (let z = Math.ceil(this.bounds.z0 / 10) * 10; z <= this.bounds.z1; z += 10) {
      const a = this.toMap(this.bounds.x0, z), b = this.toMap(this.bounds.x1, z);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }

    // 水域
    const wa = this.toMap(this.bounds.x0, this.bounds.z0);
    const wb = this.toMap(this.bounds.x1, -66);
    g.fillStyle = 'rgba(12,32,48,.85)';
    g.fillRect(wa.x, wa.y, wb.x - wa.x, wb.y - wa.y);
    g.strokeStyle = 'rgba(90,150,180,.35)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(wa.x, wb.y); g.lineTo(wb.x, wb.y); g.stroke();
    g.font = '500 16px ui-monospace, monospace';
    g.fillStyle = 'rgba(120,180,210,.5)';
    g.fillText('子午线港 · 三号泊位 / BERTH 3', wa.x + 24, (wa.y + wb.y) / 2);
    g.fillStyle = 'rgba(120,180,210,.35)';
    g.fillText('MV SOLSTICE VIGIL', wa.x + 24, (wa.y + wb.y) / 2 + 22);

    // 建筑体块
    for (const b of this.game.world.grid.boxes) {
      const h = b.max.y - b.min.y;
      if (h < 1.0) continue;
      const a = this.toMap(b.min.x, b.min.z), d = this.toMap(b.max.x, b.max.z);
      const x = Math.min(a.x, d.x), y = Math.min(a.y, d.y);
      const w = Math.max(1.5, Math.abs(d.x - a.x)), hh = Math.max(1.5, Math.abs(d.y - a.y));
      if (b.tag === 'container') { g.fillStyle = 'rgba(96,124,112,.55)'; g.strokeStyle = 'rgba(150,190,170,.4)'; }
      else if (b.tag === 'glass') continue;
      else if (b.tag === 'fence') { g.fillStyle = 'rgba(120,150,170,.10)'; g.strokeStyle = 'rgba(140,180,200,.28)'; }
      else if (b.tag === 'prop') { g.fillStyle = 'rgba(120,120,130,.45)'; g.strokeStyle = 'rgba(140,140,150,.35)'; }
      else { g.fillStyle = 'rgba(70,92,110,.72)'; g.strokeStyle = 'rgba(150,195,215,.55)'; }
      g.lineWidth = b.tag === 'container' ? 0.8 : 1.4;
      g.fillRect(x, y, w, hh);
      g.strokeRect(x, y, w, hh);
    }

    // 区域框（文字改为逐帧走标签避让层，见 drawLabels）
    for (const z of this.game.world.zones) {
      const a = this.toMap(z.x0, z.z0), d = this.toMap(z.x1, z.z1);
      const x = Math.min(a.x, d.x), y = Math.min(a.y, d.y);
      const w = Math.abs(d.x - a.x), hh = Math.abs(d.y - a.y);
      g.save();
      g.setLineDash([6, 5]);
      g.strokeStyle = 'rgba(160,205,225,.28)';
      g.lineWidth = 1.2;
      g.strokeRect(x, y, w, hh);
      g.restore();
    }

    // 出入口
    g.strokeStyle = 'rgba(242,182,74,.85)'; g.lineWidth = 3;
    const ga = this.toMap(-7, 50);
    const gb = this.toMap(7, 50);
    g.beginPath(); g.moveTo(ga.x, ga.y); g.lineTo(gb.x, gb.y); g.stroke();
    this._gateLabel = { x: gb.x + 10, y: ga.y - 10 };

    this.static = c;
  }

  show() {
    this.el.classList.remove('hidden');
    this.open = true;
    this.relayout();
  }

  hide() {
    this.el.classList.add('hidden');
    this.open = false;
  }

  toggle() { this.open ? this.hide() : this.show(); }

  render() {
    const g = this.ctx;
    const game = this.game;
    const p = game.player;
    this._ln = 0;                                     // 重置标签池
    if (!this.static && this.W > 0) this.buildStatic();  // 不依赖 show()/relayout() 的调用顺序
    if (!this.static) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);   // 逻辑像素 → 设备像素
    g.clearRect(0, 0, this.W, this.H);
    g.drawImage(this.static, 0, 0, this.W, this.H);

    /* 地名候选：按「到玩家距离 − 区域半径」排序，近处/大范围优先 */
    for (const z of game.world.zones) {
      const cx = (z.x0 + z.x1) / 2, cz = (z.z0 + z.z1) / 2;
      const rad = Math.min(z.x1 - z.x0, z.z1 - z.z0) / 2;
      const m = this.toMap(cx, cz);
      if (m.x < -60 || m.y < -40 || m.x > this.W + 60 || m.y > this.H + 40) continue;
      this.pushLabel(z.label, m.x + 7, m.y - 8, 5, FONT_ZONE, 'rgba(190,225,240,.78)',
        dist2D(cx, cz, p.pos.x, p.pos.z) - rad);
    }
    if (this._gateLabel) {
      this.pushLabel('GATE 1 · 南门', this._gateLabel.x, this._gateLabel.y, 5, FONT_SM,
        'rgba(242,182,74,.9)', dist2D(-7, 50, p.pos.x, p.pos.z));
    }

    // 航点与路径
    const wp = game.squadWaypoint;
    if (wp) {
      const m = this.toMap(wp.x, wp.z);
      g.save();
      g.strokeStyle = '#54d6c6'; g.lineWidth = 2;
      g.beginPath(); g.arc(m.x, m.y, 13, 0, 6.3); g.stroke();
      g.beginPath(); g.moveTo(m.x - 20, m.y); g.lineTo(m.x + 20, m.y); g.moveTo(m.x, m.y - 20); g.lineTo(m.x, m.y + 20); g.stroke();
      g.fillStyle = '#54d6c6';
      g.font = '600 12px ui-monospace, monospace';
      g.fillText('移动清场', m.x + 18, m.y - 16);
      g.restore();
      // 连线
      g.save();
      g.setLineDash([7, 6]);
      g.strokeStyle = 'rgba(84,214,198,.5)'; g.lineWidth = 1.6;
      for (const s of game.squad) {
        if (!s.alive) continue;
        const a = this.toMap(s.pos.x, s.pos.z);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(m.x, m.y); g.stroke();
      }
      g.restore();
    }
    const fm = game.focusMarker;
    if (fm) {
      const m = this.toMap(fm.x, fm.z);
      g.save();
      g.strokeStyle = 'rgba(242,182,74,.9)'; g.lineWidth = 2;
      g.beginPath(); g.arc(m.x, m.y, 9, 0, 6.3); g.stroke();
      g.beginPath(); g.moveTo(m.x, m.y - 15); g.lineTo(m.x, m.y - 6); g.stroke();
      g.restore();
    }

    // 事件（黄点）：枪声 / 警讯 / 爆炸 / 情报 / 伤亡
    for (const ev of game.mapEvents || []) {
      const age = game.missionTime - ev.t;
      if (age > EVENT_TTL) continue;
      const m = this.toMap(ev.x, ev.z);
      if (m.x < -20 || m.y < -20 || m.x > this.W + 20 || m.y > this.H + 20) continue;
      g.save();
      g.globalAlpha = age > 60 ? 0.42 : 0.95;
      g.fillStyle = MAP_COLORS.event;
      g.beginPath(); g.arc(m.x, m.y, 4.5, 0, 6.3); g.fill();
      g.strokeStyle = 'rgba(255,212,71,.5)'; g.lineWidth = 1.3;
      g.beginPath(); g.arc(m.x, m.y, 8, 0, 6.3); g.stroke();
      if (age < 15) {
        this.pushLabel(ev.label, m.x + 12, m.y - 9, 2, FONT_SM, 'rgba(255,226,140,.95)',
          dist2D(ev.x, ev.z, p.pos.x, p.pos.z));
      }
      g.restore();
    }

    // 任务点
    for (const key of ['manifest', 'evidence', 'extract']) {
      const o = game.world.objectives[key];
      const st = game.objectiveState[key];
      if (st === 'done' && key !== 'extract') continue;
      if (key === 'extract' && game.objectiveState.evidence !== 'done') continue;
      const m = this.toMap(o.x, o.z);
      g.save();
      g.translate(m.x, m.y);
      g.rotate(Math.PI / 4);
      g.fillStyle = st === 'done' ? 'rgba(84,214,198,.9)' : MAP_COLORS.objective;
      g.fillRect(-7, -7, 14, 14);
      g.restore();
      this.pushLabel(o.label, m.x + 14, m.y, 0, FONT_MD,
        st === 'done' ? '#54d6c6' : MAP_COLORS.objective, dist2D(o.x, o.z, p.pos.x, p.pos.z));
    }

    // 小队
    for (const s of game.squad) {
      const m = this.toMap(s.pos.x, s.pos.z);
      g.save();
      g.translate(m.x, m.y);
      g.rotate(-s.yaw);            // 修正：原先多加了 π，箭头与扇形都反向 180°
      g.fillStyle = s.alive ? MAP_COLORS.friendly : '#ff6152';
      g.beginPath(); g.moveTo(0, -10); g.lineTo(7.5, 8); g.lineTo(0, 4.5); g.lineTo(-7.5, 8); g.closePath(); g.fill();
      g.restore();
      this.pushLabel(s.callsign, m.x + 11, m.y, 3, FONT_SM, 'rgba(220,238,250,.9)',
        dist2D(s.pos.x, s.pos.z, p.pos.x, p.pos.z));
      // 朝向扇形
      g.save();
      g.translate(m.x, m.y);
      g.rotate(-s.yaw);
      g.fillStyle = 'rgba(78,168,255,.13)';
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 90, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); g.closePath(); g.fill();
      g.restore();
    }

    // 嫌疑人 / 平民
    for (const a of game.actors) {
      if (a.kind === 'squad' || a.kind === 'player' || a.safe) continue;   // 主角由中心箭头单独绘制
      const m = this.toMap(a.pos.x, a.pos.z);
      const known = a.kind === 'civilian' ? a.seen : a.seen;
      if (a.kind === 'suspect') {
        if (a.identified) {
          /* 已识别的敌人 = 橙色点（投降/被拘押改为空心圈以示状态） */
          const down = !a.alive;
          g.strokeStyle = MAP_COLORS.enemy;
          g.fillStyle = MAP_COLORS.enemy;
          g.lineWidth = 2;
          g.beginPath(); g.arc(m.x, m.y, 5.5, 0, 6.3);
          if (a.surrendered || a.detained || down) { g.stroke(); } else { g.fill(); }
          g.globalAlpha = 0.45;
          g.beginPath(); g.arc(m.x, m.y, 9.5, 0, 6.3); g.stroke();
          g.globalAlpha = 1;
          this.pushLabel(a.name + (a.detained ? ' · 已拘押' : a.surrendered ? ' · 已投降' : ''),
            m.x + 12, m.y, 4, FONT_SM, 'rgba(255,190,140,.9)',
            dist2D(a.pos.x, a.pos.z, p.pos.x, p.pos.z));
        } else if (known) {
          /* 未识别接触：保持灰色问号 —— “先观察再下令”的核心机制 */
          g.strokeStyle = MAP_COLORS.unknown; g.lineWidth = 1.8;
          g.beginPath(); g.arc(m.x, m.y, 6.5, 0, 6.3); g.stroke();
          g.fillStyle = MAP_COLORS.unknown;
          g.font = '700 12px ui-monospace, monospace';
          g.fillText('?', m.x - 3, m.y + 4);
        }
      } else {
        if (!known && !a.identified) continue;
        g.fillStyle = MAP_COLORS.civilian;
        g.fillRect(m.x - 5, m.y - 5, 10, 10);
        this.pushLabel('平民', m.x + 9, m.y, 4, FONT_SM, 'rgba(160,230,160,.85)',
          dist2D(a.pos.x, a.pos.z, p.pos.x, p.pos.z));
      }
    }

    // 队长
    const pm = this.toMap(p.pos.x, p.pos.z);
    g.save();
    g.translate(pm.x, pm.y);
    g.rotate(-p.yaw);              // 修正：去掉多余的 π
    /* 主角同样用蓝色，外加双圈便于在队友中辨认自己 */
    g.fillStyle = MAP_COLORS.friendly;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(8, 8); g.lineTo(0, 4.5); g.lineTo(-8, 8); g.closePath(); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(8, 8); g.lineTo(0, 4.5); g.lineTo(-8, 8); g.closePath(); g.stroke();
    g.restore();
    g.strokeStyle = 'rgba(78,168,255,.55)';
    g.beginPath(); g.arc(pm.x, pm.y, 16, 0, 6.3); g.stroke();
    g.save();
    g.translate(pm.x, pm.y);
    g.rotate(-p.yaw);
    g.fillStyle = 'rgba(78,168,255,.10)';
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 150, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42); g.closePath(); g.fill();
    g.restore();

    // 光标预览
    if (this.hoverWorld) {
      const m = this.toMap(this.hoverWorld.x, this.hoverWorld.z);
      g.save();
      g.strokeStyle = 'rgba(242,182,74,.75)'; g.lineWidth = 1.4;
      g.setLineDash([4, 4]);
      g.beginPath(); g.arc(m.x, m.y, 18, 0, 6.3); g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(242,182,74,.75)';
      g.font = '500 12px ui-monospace, monospace';
      g.fillText(`${Math.round(this.hoverWorld.x)}, ${Math.round(this.hoverWorld.z)}`, m.x + 22, m.y - 18);
      g.restore();
    }

    // 比例尺
    g.strokeStyle = 'rgba(160,205,225,.5)'; g.lineWidth = 2;
    const s0 = this.toMap(this.bounds.x0 + 6, this.bounds.z1 - 6);
    const lenPx = 20 * this.scale;
    g.beginPath(); g.moveTo(s0.x, s0.y); g.lineTo(s0.x + lenPx, s0.y); g.stroke();
    g.beginPath(); g.moveTo(s0.x, s0.y - 5); g.lineTo(s0.x, s0.y + 5); g.stroke();
    g.beginPath(); g.moveTo(s0.x + lenPx, s0.y - 5); g.lineTo(s0.x + lenPx, s0.y + 5); g.stroke();
    g.fillStyle = 'rgba(160,205,225,.7)';
    g.font = '500 12px ui-monospace, monospace';
    g.fillText('20 m', s0.x + lenPx + 8, s0.y + 4);

    /* 最后统一绘制所有标签：按优先级 + 距离排序，逐个做边界裁剪与碰撞避让 */
    this.drawLabels(g);
  }
}
