/* ============================================================
   hud.js — heads-up display: target card, compass, squad panel, minimap, log
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
      whiteout: $('#whiteout'),   // cached: flash() used to re-query getElementById on every call
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
    /* Minimap: offscreen static building layer + reused buffers + label avoidance (all zero-allocation) */
    this.miniStatic = null;
    this.miniStaticBounds = null;
    this.pt = { x: 0, y: 0 };            // reused coordinate buffer
    this.placer = new LabelPlacer(48);
    this.zoneItems = [];                 // precomputed place-name candidates (area included for sorting)
    this.miniRange = 46;
    this.drawnLabels = [];      // place names actually drawn this frame (for __mapDebug lookup)
    this.drawnN = 0;
    this.labelStats = { total: 0, drawn: 0, rejected: 0, edge: 0 };
    /* Per-frame write cache: touch the DOM only when the value actually changes.
       Measured (tools/perf-probe.mjs), this used to cause about 27 DOM mutations and 55 layout reads per frame,
       the vast majority of them rewriting the same string/class name — each one produces a
       mutation record and may trigger style recalculation. */
    this._w = Object.create(null);
    this._roster = [];                   // reused roster buffer, avoiding per-frame spread allocation
    this._intTick = 0;
    this._intCache = null;
    this.buildMiniStatic();
    this.buildZoneItems();
    /* 3. Recompute canvas size on layout changes (including DPR changes from browser zoom) */
    this.sizeWatch = watchResize(document.getElementById('hud') || document.body, () => this.onResize());
  }

  /* ------------------------------------------------------------
     Write-cache helpers: compare before writing; if identical, skip entirely (no DOM mutation)
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
  /* classList.toggle is idempotent (no mutation when unchanged); this short-circuits just to save call overhead */
  _cls(key, el, name, on) {
    const k = key + '|' + name;
    if (this._w[k] === on) return;
    this._w[k] = on;
    el.classList.toggle(name, on);
  }
  /* Cached canvas CSS size: written once per frame by drawMinimap and reused by worldToMap */
  _syncCanvasSize() {
    const cv = this.el.minimap;
    this._W = cv.clientWidth || 1;
    this._H = cv.clientHeight || 1;
  }

  /* ------------------------------------------------------------
     Static building layer: baked once into an offscreen canvas (world coordinates 1:1, 6 px/m)
     One rotated drawImage per frame instead of redrawing ~200 rectangles building by building
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
    g.setTransform(SPP, 0, 0, SPP, -x0 * SPP, -z0 * SPP);   // afterwards use world-meter coordinates directly
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

  /* Place-name candidates: larger areas are placed first, so small rooms (office / dispatch room) naturally lose collision */
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
    /* Cached sort-key comparator: created once and reused every frame, avoiding GC */
    this._zoneCmp = (a, b) => a.key - b.key;
  }

  /* ------------------------------------------------------------
     World coordinates → minimap pixel coordinates
     (1) translate so the player is the origin → (2) rotate around the origin by +yaw → (3) scale k → (4) translate to canvas center
     (rotation center = the player; angle recomputed from absolute yaw every frame, with no accumulated drift)
     ------------------------------------------------------------ */
  worldToMap(wx, wz, out) {
    const p = this.game.player;
    /* Sizes come from the cache: drawMinimap reads layout once per frame and writes _W/_H.
       This used to read clientWidth/clientHeight on every call, and this function is called
       about 25 times per frame (objectives + events + all actors + place names) — the main cause of 50+ layout reads per frame. */
    if (!this._W || !this._H) this._syncCanvasSize();
    const W = this._W, H = this._H;
    /* The angle still uses live yaw and does not depend on last frame's cache
       (otherwise querying right after externally changing yaw would return the old angle) */
    const k = (W / 2) / this.miniRange;
    const C = Math.cos(p.yaw), S = Math.sin(p.yaw);
    const dx = wx - p.pos.x, dz = wz - p.pos.z;
    out = out || this.pt;
    out.x = W / 2 + k * (C * dx - S * dz);
    out.y = H / 2 + k * (S * dx + C * dz);
    return out;
  }

  onResize() {
    // Redraw both canvases immediately on size changes, avoiding a stretched old frame
    if (this.game && this.game.world && this.game.player) {
      this.updateCompass(this.game);
      this.drawMinimap(this.game);
    }
  }

  /* ---------------- Static structure ---------------- */
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
        <span class="st">STANDBY</span>
        <span class="hp" style="grid-column:2/4"><i style="width:100%"></i></span>`;
      this.el.squadList.appendChild(d);
      this.squadEls[a.id] = { root: d, hp: d.querySelector('.hp i'), st: d.querySelector('.st') };
    });
  }

  /* ---------------- Per frame ---------------- */
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
    /* stroke-dasharray is already a static value in ui.css (264), so no need to rewrite it every frame;
       only dashoffset changes continuously with identification progress. */
    const off = ringR * (1 - (game.observeTarget ? game.observeTarget.ident : 0));
    if (this._w.ringOff !== off) { this._w.ringOff = off; this.el.observeFg.style.strokeDashoffset = off; }
    this.el.observeRing.classList.toggle('on', !!game.observeTarget && game.observeTarget.ident < 1);

    /* Interaction prompt: findInteraction walks every actor and builds objects/template strings,
       so there is no need to compute it every frame — refresh every 4 frames; imperceptible in play.
       Note that doInteract() is still called live on key press, keeping the action and the prompt in sync. */
    if ((this._intTick++ & 3) === 0) this._intCache = p.findInteraction();
    const it = this._intCache;
    if (it) {
      this._cls('prompt', this.el.prompt, 'hidden', false);
      this._text('promptText', this.el.promptText, it.label);
    } else {
      this._cls('prompt', this.el.prompt, 'hidden', true);
    }

    // Subtitle / log timers
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
    /* This method used to be called every frame and unconditionally rewrote innerHTML —
       a full HTML parse + subtree replacement every frame, the biggest source of single-frame DOM mutations.
       Update only when the mode actually changes. */
    if (this._w.cursorMode === on) return;
    this._w.cursorMode = on;
    this.el.cursorHint.classList.toggle('on', on);
    this.el.cursorHint.innerHTML = on
      ? 'MOUSE RELEASED — click the command buttons (click the view to restore look)'
      : 'Press <b>Alt</b> to release the mouse, then click the command buttons above';
  }

  updateObjectives(game) {
    for (const li of this.el.objectives.children) {
      const st = game.objectiveState[li.dataset.id];
      const k = 'obj:' + li.dataset.id;
      if (this._w[k] === st) continue;      // skip the whole item when the state is unchanged
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
    /* Counting loops replace filter(): this used to allocate two arrays per frame */
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
      game.squadOrder === 'clear' && game.squadWaypoint ? `${order.cn} · MOVING TO WAYPOINT` : order.cn);
    for (const cmd of this.el.commandBar.children) {
      cmd.classList.toggle('active', cmd.dataset.cmd === game.squadOrder);
    }
    /* Reuse the same array, avoiding per-frame [player, ...squad] spread allocation */
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
      let st = 'STANDBY';
      if (!a.alive) st = 'INCAPACITATED';
      else if (a.blind > 0) st = 'BLINDED';
      else if (a.kind === 'player') st = a.stance === 'sprint' ? 'SPRINTING' : a.stance === 'sneak' ? 'SNEAKING' : 'MOVING';
      else if (a.vel > 0.4) st = 'ADVANCING';
      if (a.aimTarget) st = 'IN CONTACT';
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
    /* Update the percentage text only while visible (it used to be written every frame even when hidden) */
    if (loading) {
      this._text('wpReloadTxt', this.el.wpReload,
        `RELOADING… ${Math.max(0, (p.reloading / d.reload) * 100).toFixed(0)}%`);
    }
  }

  updateTarget(game) {
    const t = game.observeTarget;
    // A downed teammate still shows status (can be revived); downed enemies/civilians no longer show
    if (!t || (!t.alive && t.kind !== 'squad')) {
      this._cls('tc', this.el.targetCard, 'hidden', true);
      return;
    }
    this._cls('tc', this.el.targetCard, 'hidden', false);
    const range = Math.round(Math.hypot(t.pos.x - game.player.pos.x, t.pos.z - game.player.pos.z));
    this._text('tcRange', this.el.tcRange, range + ' m');
    this._width('tcIdent', this.el.tcIdent, (t.ident * 100).toFixed(0));

    /* Variant classes: this used to clear with `className = ''` and re-add — even with an identical result,
       every frame produced a class attribute mutation. Now only differences are added/removed. */
    let variant = '';
    let cls = '', note = '';
    if (t.ident >= 0.8) {
      if (t.kind === 'suspect') {
        variant = 'armed';
        cls = t.surrendered ? 'SUSPECT · SURRENDERED' : 'ARMED SUSPECT';
        note = t.surrendered ? 'Close in to detain (E)' : (t.name || '');
      } else if (t.kind === 'civilian') {
        variant = 'civilian';
        cls = 'CIVILIAN · NON-COMBATANT';
        note = 'Shooting them fails the mission · E to escort out';
      } else {
        variant = 'friendly';
        cls = t.callsign || 'SECURITY PERSONNEL';
        note = t.alive
          ? `FRIENDLY · ${t.tag || 'SECURITY PERSONNEL'} (immune to your fire)`
          : 'INCAPACITATED · Needs trauma kit (E)';
      }
    } else if (t.ident >= 0.35) {
      cls = 'PERSONNEL CONTACT · UNIDENTIFIED';
      note = 'Keep observing to confirm target · HOLD TO IDENTIFY';
    } else {
      cls = 'UNKNOWN CONTACT';
      note = 'Movement suspected · Observe to identify';
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
    if (!cssW) return;                       // don't draw when the element is hidden at a breakpoint
    /* backing store = CSS size × DPR; drawing still uses 720×58 design coordinates */
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
    const span = 130; // visible angle
    const pxPerDeg = w / span;

    // Ticks
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

    // Markers
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
    if (!cssW || !cssH) return;              // don't draw when hidden at a breakpoint
    const dpr = canvasDpr();
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);    // from here on, draw in CSS pixels
    const W = cssW, H = cssH;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(6,11,16,.85)';
    c.fillRect(0, 0, W, H);
    const p = game.player;
    const range = this.miniRange;
    const k = (W / 2) / range;
    /* Rotation uses +yaw: when the player turns right, what was straight ahead moves left.
       (Note this project's yaw decreases when turning right, see player.look()) */
    const C = Math.cos(p.yaw), S = Math.sin(p.yaw);
    this._C = C; this._S = S; this._k = k; this._W = W; this._H = H;

    /* ---- Static building layer: rotation done by one drawImage ----
       The matrix is equivalent to translate(-p) → rotate(+yaw) → scale(k) → translate(center) */
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
    // Objectives
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
    // Events (yellow dots)
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
    // Units
    for (const a of game.actors) {
      if (a.safe || a === p) continue;        // the player is drawn separately as the center arrow, avoiding a blue dot + white triangle overlap
      const known = a.kind === 'squad' || a.kind === 'civilian' ? true : a.seen;
      if (!known) continue;
      const m = this.worldToMap(a.pos.x, a.pos.z, this.pt);
      if (m.x < 2 || m.x > W - 2 || m.y < 2 || m.y > H - 2) continue;
      let col = MAP_COLORS.friendly;                       // player and teammates — blue
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
    /* ---- View cone: angle taken from the real camera's horizontal FOV, exactly matching the crosshair ---- */
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

    /* ---- Place-name labels (horizontal, non-rotating; area priority + collision avoidance) ---- */
    const placer = this.placer;
    placer.reset();
    placer.reserve(W / 2 - 16, H / 2 - 16, 32, 32);        // reserve the center for the player icon
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
      z.key = z.dist - z.radius;             // near / large areas first
    }
    if (this._zoneCmp) items.sort(this._zoneCmp);
    for (let i = 0; i < items.length; i++) {
      const z = items[i];
      const dist = z.dist;
      const m = this.worldToMap(z.x, z.z, this.pt);
      if (dist > visibleR) {
        /* Outside the visible range: clamp to the edge and draw a direction arrow instead of dropping it or stacking it in a corner */
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
      if (tx < 2 || ty - 8 < 2 || tx + tw > W - 2 || ty + 8 > H - 2) continue;   // out of bounds, skip
      if (!placer.tryPlace(tx - 3, ty - 8, tw + 6, 16)) { stats.rejected++; continue; }  // yield on overlap
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

    /* ---- Player: fixed at the center, arrow always up (player-up mode) ---- */
    c.save();
    c.translate(W / 2, H / 2);
    c.fillStyle = MAP_COLORS.friendly;
    c.beginPath(); c.moveTo(0, -7); c.lineTo(5, 5.5); c.lineTo(0, 3); c.lineTo(-5, 5.5); c.closePath(); c.fill();
    c.strokeStyle = '#ffffff'; c.lineWidth = 1.2; c.stroke();
    c.restore();
  }

  /* ---------------- Feedback ---------------- */
  hit(kill = false) {
    this.el.hitmarker.classList.remove('show');
    void this.el.hitmarker.offsetWidth;
    this.el.hitmarker.classList.toggle('kill', kill);
    this.el.hitmarker.classList.add('show');
    this.hitTimer = feel.feedback.hitmarkerTime;
  }

  flash(alpha = 0.85) {
    /* 4. Pure CSS compositing layer: only change opacity (transform/opacity are handled by the compositor),
       do not write background, read pixels, or touch #grade's gradient + filter. */
    const w = this.el.whiteout;
    if (!w) return;
    w.style.transition = 'none';
    w.style.opacity = String(Math.min(1, Math.max(0, alpha)));
    // Force one style flush before starting the transition, so the fade starts from the current opacity
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
    this.el.subtitle.innerHTML = who ? `<b>${who}</b>: ${text}` : text;
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
