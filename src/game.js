/* ============================================================
   game.js — 任务编排：指令系统、识别机制、目标流程、渲染循环
   ============================================================ */
import * as THREE from 'three';
import { buildWorld } from './world.js';
import { NavGrid } from './nav.js';
import { Effects, updateProjectiles, sweepProjectiles, castRay } from './combat.js';
import { SquadMember, Suspect, Civilian } from './actors.js';
import { Player } from './player.js';
import { ViewModel } from './viewmodel.js';
import { HUD } from './hud.js';
import { TacMap } from './tacmap.js';
import { Screens } from './screens.js';
import { Audio } from './audio.js';
import { clamp, dist2D, TAU, losBlocked, makeRng } from './geom.js';
import { watchResize, canvasDpr } from './canvasfit.js';
import { feel, telemetry } from './feel.js';
import { TuningPanel } from './tuning.js';
import { TUNING, LINES, DIRECTIONS, ORDER_NAMES, COMMS } from './data.js';

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(canvasDpr(2));   // 真实 DPR 在 resize() 里随时更新
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 420);
    this.audio = new Audio();
    this.state = 'menu';
    this.timeScale = 1;
    this.paused = false;
    this.tacticalPause = false;
    this.rng = makeRng(991);
    this.resizeCount = 0;
    this.resize();
    /* 3. 用 ResizeObserver + DPR 监听替代 onresize：
          拖动窗口、浏览器缩放（Cmd +/-）、外接屏切换都能覆盖 */
    this.sizeWatch = watchResize(document.getElementById('app') || document.body, () => this.resize());
    this.bindInput();
    this.screens = new Screens(this);
    this.tuning = new TuningPanel(this);   // 手感调参面板（P 唤出）
    this.screens.show('title');
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
    });
    this.last = performance.now();
    /* 性能埋点：用于验证“连续触发闪光弹不卡死”的验收标准 */
    this.perf = {
      frames: 0, logicSum: 0, logicMax: 0, logicAvg: 0, lastLogic: 0,
      renderMs: 0, lastGap: 0, worstGap: 0, fps: 0, stalls: 0,
      _lastPush: 0, _gapT: performance.now(),
    };
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  resize() {
    const host = document.getElementById('app') || document.body;
    const w = Math.max(1, host.clientWidth || window.innerWidth);
    const h = Math.max(1, host.clientHeight || window.innerHeight);
    this.renderer.setPixelRatio(canvasDpr(2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.viewmodel) this.viewmodel.resize(w, h);
    this.viewport = { w, h, dpr: canvasDpr(2) };
    this.resizeCount++;
  }

  /* ============================================================
     输入
     ============================================================ */
  bindInput() {
    this.input = {
      keys: new Set(), lmb: false, rmb: false,
      /* lmbPressed 是「本帧新按下」的沿信号，决定半自动/泵动/左轮是否击发。
         必须在 player.update() 之后再清除，否则在当帧就被吃掉。 */
      lmbPressed: false,
    };
    const canvas = this.canvas;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.input.keys.add(e.code);
      if (e.code === 'Tab') { e.preventDefault(); if (this.state === 'play') this.toggleTacMap(); return; }
      if (e.code === 'Escape') { if (this.state === 'play') this.togglePause(true); return; }
      /* ---- 调参面板快捷键（不依赖游戏状态） ---- */
      if (this.tuning) {
        if (e.code === 'KeyP') { e.preventDefault(); this.tuning.toggle(); return; }
        if (e.code === 'KeyO') { e.preventDefault(); this.tuning.toggleOverlay(); return; }
        if (this.tuning.overlay) {
          if (e.code === 'BracketLeft') { e.preventDefault(); this.tuning.adjust(-1); return; }
          if (e.code === 'BracketRight') { e.preventDefault(); this.tuning.adjust(1); return; }
          if (e.code === 'Comma') { e.preventDefault(); this.tuning.cycle(-1); return; }
          if (e.code === 'Period') { e.preventDefault(); this.tuning.cycle(1); return; }
        }
      }
      if (this.state !== 'play') return;
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault();
        this.setCursorMode(!this.cursorMode);
        return;
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) e.preventDefault();
      if (e.code === 'KeyR') this.player.startReload();
      if (e.code === 'KeyE') this.player.doInteract();
      if (e.code === 'KeyF') {
        this.lightOn = !this.lightOn;
        this.log(this.lightOn ? '战术灯开启 — 观察距离提升，但也更易被发现' : '战术灯关闭 — 隐蔽性提升', '');
        this.audio.click(0.2, 1500);
      }
      if (e.code === 'KeyM') {
        this.audio.setMuted(!this.audio.muted);
        this.log(this.audio.muted ? '音频已静音' : '音频已开启', '');
      }
      if (e.code === 'Digit1') this.issueOrder('follow');
      if (e.code === 'Digit2') this.issueOrder('hold');
      if (e.code === 'Digit3') this.issueOrder('clear');
      if (e.code === 'Digit4') this.issueOrder('regroup');
    });
    window.addEventListener('keyup', (e) => {
      this.input.keys.delete(e.code);
      if (e.code === 'Space') this.setTacticalPause(false);
    });
    window.addEventListener('blur', () => {
      this.input.keys.clear(); this.input.lmb = false; this.input.rmb = false; this.input.lmbPressed = false;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (this.state !== 'play') return;
      if (e.button === 0) { this.input.lmb = true; this.input.lmbPressed = true; }
      if (e.button === 2) this.input.rmb = true;
      if (e.button === 1) { e.preventDefault(); this.player.switchWeapon(); }
      // 点击画面 = 回到鼠标视角
      if (this.cursorMode) this.setCursorMode(false);
      else if (!this.locked && !this.tacmap?.open) this.requestLock();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.input.lmb = false; }
      if (e.button === 2) this.input.rmb = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (this.state !== 'play' || !this.locked) return;
      this.player.look(e.movementX, e.movementY);
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.state !== 'play') return;
      e.preventDefault();
      this.player.switchWeapon();
    }, { passive: false });

    // 指令栏点击由 Screens 的事件委托统一处理（见 screens.js wire()）
  }

  requestLock() {
    if (!this.canvas.requestPointerLock) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 无用户手势时忽略 */ }
  }

  /**
   * 光标模式：指针锁定期间浏览器会把所有鼠标点击投递给画布，
   * HUD 上的按钮永远收不到点击。按 Alt 释放指针即可正常点击界面。
   */
  setCursorMode(on) {
    if (this.state !== 'play') return;
    if (this.tacmap && this.tacmap.open) return;
    if (this.cursorMode === on) return;
    this.cursorMode = on;
    if (on) {
      if (document.exitPointerLock) document.exitPointerLock();
      this.log('鼠标已释放 — 可点击指令按钮（Alt 或点击画面恢复视角）', '');
      this.audio.click(0.16, 1400);
    } else {
      this.requestLock();
    }
    if (this.ui) this.ui.setCursorMode(on);
  }

  /* ============================================================
     部署任务
     ============================================================ */
  deploy(loadout) {
    this.disposeMission();
    this.audio.init();
    this.audio.resume();
    this.audio.startAmbience();          // 环境声只在进入行动后开启
    this.loadout = loadout || this.loadout;

    this.scene = new THREE.Scene();
    this.world = buildWorld(this.scene, this.renderer);
    this.nav = new NavGrid(this.world.grid, { x0: -74, x1: 74, z0: -66, z1: 52 }, 1.5, 0.62);
    this.effects = new Effects(this.scene);
    this.projectiles = [];
    this.actors = [];
    this.squad = [];
    this.suspects = [];
    this.civilians = [];
    this.actingMember = null;
    this.observeTarget = null;
    this.squadWaypoint = null;
    this.focusMarker = null;
    this.boundPhase = 0;
    this.boundTimer = 0;
    this.elementDone = [false, false];   // 交替掩护：两个小组是否已抵达航点
    this.weaponsFree = false;
    this.alarmRaised = false;
    this.alertPulse = 0;
    this.camShake = 0; this.camShakeY = 0; this.camShakeZ = 0;
    this.cursorMode = false;
    this.tacticalPause = false;
    this._clearReported = false;
    this.missionTime = 0;
    this.clock = 23 * 3600 + 41 * 60;
    this.failed = false;
    this.failReason = '';
    this.beats = [];
    this.squadOrder = 'follow';
    this.stats = { shots: 0, hits: 0, blindShots: 0, orders: 0, gadgets: 0, revives: 0, detonations: 0 };
    this.mapEvents = [];        // 地图事件点（黄色）
    this.objectiveState = {
      manifest: 'active', evidence: 'active', civilians: 'active',
      suspects: 'active', extract: 'pending',
    };
    this.counters = { detained: 0, killed: 0, civLost: 0, civSafe: 0, squadDown: 0 };

    /* --- 队长 --- */
    const sp = this.world.spawns.player;
    this.player = new Player(this, { x: sp.x, z: sp.z, yaw: sp.yaw, loadout: this.loadout });
    this.actors.push(this.player);

    /* --- 小队 --- */
    this.roster = [
      { callsign: 'ARDEN-2', name: 'K. 阿登', tag: 'RIFLEMAN · 侦察' },
      { callsign: 'BRAM-3', name: 'S. 布拉姆', tag: 'RIFLEMAN · 火力' },
      { callsign: 'CIRA-4', name: 'M. 席拉', tag: 'BREACHER · 突击' },
      { callsign: 'DOV-5', name: 'L. 多夫', tag: 'MEDIC · 支援' },
    ];
    this.roster.forEach((r, i) => {
      const s = this.world.spawns.squad[i];
      const m = new SquadMember(this, { ...r, x: s.x, z: s.z, yaw: s.yaw }, i);
      this.squad.push(m); this.actors.push(m);
    });

    /* --- 嫌疑人 --- */
    this.world.suspects.forEach((cfg) => {
      const pos = cfg.patrol ? { x: cfg.patrol[0][0], z: cfg.patrol[0][1] } : { x: cfg.post[0], z: cfg.post[1] };
      const s = new Suspect(this, { ...cfg, x: pos.x, z: pos.z, yaw: Math.random() * TAU });
      this.suspects.push(s); this.actors.push(s);
    });

    /* --- 平民 --- */
    this.world.civilians.forEach((cfg) => {
      const c = new Civilian(this, cfg);
      this.civilians.push(c); this.actors.push(c);
    });

    /* --- 任务物品 --- */
    this.objectiveProps = {};
    const folder = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.26),
      new THREE.MeshStandardMaterial({ color: 0xc8b68a, roughness: 0.8 }));
    folder.position.set(-31.4, 0.87, -23.5);
    this.scene.add(folder);
    this.objectiveProps.manifest = { mesh: folder, x: -31.4, z: -23.5, label: '货运货单', taken: false };
    this.objectiveProps.manifestGlow = this.addGlow(-31.4, 1.2, -23.5);

    const drive = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x2a343d, emissive: 0x1c5f74, emissiveIntensity: 0.9, roughness: 0.5 }));
    drive.position.set(47.0, 1.42, -38.8);
    this.scene.add(drive);
    this.objectiveProps.evidence = { mesh: drive, x: 47.0, z: -38.8, label: '调度室证据', taken: false };
    this.objectiveProps.evidenceGlow = this.addGlow(47.0, 1.7, -38.8);

    this.world.objectives.manifest.x = -31.4; this.world.objectives.manifest.z = -23.5;
    this.world.objectives.evidence.x = 47.0; this.world.objectives.evidence.z = -38.8;

    /* --- 撤离 / 焦点标记 --- */
    const ex = this.world.objectives.extract;
    this.extractRing = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.0, 32),
      new THREE.MeshBasicMaterial({ color: 0x54d6c6, transparent: true, opacity: 0, side: THREE.DoubleSide }));
    this.extractRing.rotation.x = -Math.PI / 2;
    this.extractRing.position.set(ex.x, 0.05, ex.z);
    this.scene.add(this.extractRing);

    this.focusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.66, 24),
      new THREE.MeshBasicMaterial({ color: 0xf2b64a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    this.focusRing.rotation.x = -Math.PI / 2;
    this.focusRing.visible = false;
    this.scene.add(this.focusRing);

    /* --- 武器战术灯 --- */
    this.lightOn = true;
    this.weaponLight = new THREE.SpotLight(0xe8f2ff, 92, 52, 0.55, 0.80, 1.5);
    this.weaponLight.position.set(0, 0, 0);
    this.scene.add(this.weaponLight);
    this.weaponLightTarget = new THREE.Object3D();
    this.scene.add(this.weaponLightTarget);
    this.weaponLight.target = this.weaponLightTarget;

    /* --- UI --- */
    this.ui = new HUD(this);
    this.tacmap = new TacMap(this);
    this.viewmodel = new ViewModel(this, this.camera);
    this.viewmodel.resize(window.innerWidth, window.innerHeight);
    this.world.onThunder(() => this.audio.thunder());
    this.installMapDebug();
    this.state = 'play';
    this.screens.showGame();
    this.requestLock();
    this.setBeats();
    this.log('行动开始 — 子午线港 三号泊位', 'good');
    this.ui.radio('调度 · MERIDIAN', 'ARDEN 小队，调度室在 22:58 后失联。进入港区，确认现场情况。');
  }

  addGlow(x, y, z) {
    const g = new THREE.PointLight(0xffd9a0, 5, 6, 2);
    g.position.set(x, y, z);
    this.scene.add(g);
    return g;
  }

  disposeMission() {
    if (this.scene) {
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap']) {
              if (m[k] && m[k].dispose) m[k].dispose();
            }
            m.dispose();
          });
        }
      });
      this.scene.clear();
      this.scene = null;
    }
    if (this.ui) { this.ui.el.log.innerHTML = ''; this.ui.el.radio.innerHTML = ''; }
    if (this.tacmap) { this.tacmap.hide(); this.tacmap.static = null; }
  }

  abort() {
    this.audio.stopAmbience();
    this.disposeMission();
    this.state = 'menu';
    if (document.exitPointerLock) document.exitPointerLock();
    this.screens.hideGame();
  }

  setBeats() {
    this.beats = [
      { t: 4, done: false, fn: () => this.ui.radio('ARDEN-2 · K.阿登', '队长，雨太大，光点看不远。我先看，你下令。') },
      { t: 11, done: false, fn: () => this.ui.say('按住 空格 进入战术暂停，时间会减慢。用准星压住目标直到识别完成 —— 再下令。', null, 8) },
      { t: 26, done: false, fn: () => this.ui.radio('调度 · MERIDIAN', '注意，港区内仍有夜班工人在岗。识别完成前不要开火。') },
    ];
  }

  /* ============================================================
     指令系统
     ============================================================ */
  issueOrder(cmd) {
    if (this.state !== 'play') return;
    const targetMember = this.pickSquadUnderCrosshair();
    const list = targetMember ? [targetMember] : this.squad;
    if (targetMember) this.actingMember = targetMember;

    if (cmd === 'clear') {
      const f = this.player.forward, eye = this.player.eye;
      const hit = castRay(this, eye.x, eye.y, eye.z, f.x, f.y, f.z, 95, this.player);
      const p = hit.point;
      if (dist2D(p.x, p.z, this.player.pos.x, this.player.pos.z) < 4) {
        this.log('移动清场 — 落点过近，请瞄准远处地面或目标', 'warn');
        return;
      }
      this.issueClearAt(p.x, p.z);
      return;
    }
    if (cmd === 'hold') {
      for (const m of list) { m.faceYaw = this.player.yaw; m.holdAt = { x: m.pos.x, z: m.pos.z }; }
    }
    this.squadOrder = cmd;
    this.stats.orders++;
    for (const m of list) if (m.alive) m.lastOrder = cmd;
    this.audio.radio('out');
    const name = ORDER_NAMES[cmd];
    if (cmd === 'follow') this.log(`指令 · ${name.cn} — 小队按楔形队形跟随`, 'good');
    else if (cmd === 'hold') this.log(`指令 · ${name.cn} — 小队原地警戒`, 'good');
    else if (cmd === 'regroup') this.log(`指令 · ${name.cn} — 小队收拢`, 'good');
    const line = LINES[cmd === 'follow' ? 'onFollow' : cmd === 'hold' ? 'onHold' : 'onClear'];
    if (line) {
      const t = line[Math.floor(Math.random() * line.length)]
        .replace('{who}', targetMember ? targetMember.callsign : 'ARDEN')
        .replace('{dir}', DIRECTIONS[Math.floor(Math.random() * 12)]);
      this.ui.say(t, null, 2.6);
    }
    document.querySelectorAll('#command-bar .cmd').forEach((c) => {
      if (c.dataset.cmd === cmd) { c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 260); }
    });
  }

  /**
   * 队员抵达「移动清场」航点时的回调（由 SquadMember 调用）。
   * 注意：这个方法曾经只被调用、却没有定义 —— 队员一到位就抛
   * TypeError 并中断整个模拟循环。此方法必须始终存在。
   */
  onElementArrived(member) {
    if (this.squadOrder !== 'clear' || !this.squadWaypoint) return;
    const wp = this.squadWaypoint;
    if (dist2D(member.pos.x, member.pos.z, wp.x, wp.z) >= 3.5) return;
    this.elementDone[member.element] = true;      // 交替掩护：该组已到位
    const alive = this.squad.filter((m) => m.alive);
    const allOnPoint = alive.length > 0 &&
      alive.every((m) => dist2D(m.pos.x, m.pos.z, wp.x, wp.z) < 3.5);
    if (allOnPoint && !this._clearReported) {
      this._clearReported = true;
      this.log('区域已清空 — 小队抵达航点', 'good');
      this.audio.radio('in');
      this.ui.say('ARDEN：清空，区域安全。', null, 2.4);
    }
  }

  issueClearAt(x, z) {
    if (this.state !== 'play') return;
    this._clearReported = false;
    this.squadWaypoint = { x, z };
    this.squadOrder = 'clear';
    this.stats.orders++;
    this.boundPhase = 0;
    this.boundTimer = 5.5;
    this.elementDone = [false, false];
    for (const m of this.squad) { if (m.alive) { m.path = null; m.pathAge = 2; m.lastOrder = 'clear'; } }
    const d = Math.round(dist2D(this.player.pos.x, this.player.pos.z, x, z));
    this.log(`指令 · 移动清场 — 目标方位 ${d}m，交替掩护推进`, 'good');
    this.audio.radio('out');
    this.ui.say('ARDEN：收到，交替推进。', null, 2.4);
    document.querySelectorAll('#command-bar .cmd').forEach((c) => {
      if (c.dataset.cmd === 'clear') { c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 260); }
    });
  }

  setFocusMarker(x, z) {
    this.focusMarker = { x, z };
    this.focusRing.position.set(x, 0.06, z);
    this.focusRing.visible = true;
    this.audio.click(0.2, 1000);
  }

  clearWaypoints() {
    this.squadWaypoint = null;
    this.focusMarker = null;
    this.focusRing.visible = false;
  }

  pickSquadUnderCrosshair() {
    const f = this.player.forward, eye = this.player.eye;
    let best = null, bestD = Infinity;
    for (const m of this.squad) {
      if (!m.alive) continue;
      const dx = m.pos.x - eye.x, dy = (m.y + 1.2) - eye.y, dz = m.pos.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 34) continue;
      const dot = (dx * f.x + dy * f.y + dz * f.z) / d;
      if (dot < 0.985) continue;
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  /* ============================================================
     战术暂停 / 地图 / 暂停
     ============================================================ */
  setTacticalPause(on) {
    if (this.state !== 'play' || (this.tacmap && this.tacmap.open)) return;
    if (this.tacticalPause === on) return;
    this.tacticalPause = on;
    if (on) {
      this.audio.radio('in');
      this.ui.say('战术暂停 — 观察、下令、再动手', null, 2);
    }
  }

  toggleTacMap() {
    if (!this.tacmap) return;
    if (this.tacmap.open) {
      this.tacmap.hide();
      if (!this.cursorMode) this.requestLock();
    } else {
      if (document.exitPointerLock) document.exitPointerLock();
      this.tacmap.show();
      this.audio.click(0.22, 1500);
    }
  }

  togglePause(on) {
    if (this.state !== 'play') return;
    this.paused = on;
    if (on) {
      if (document.exitPointerLock) document.exitPointerLock();
      this.screens.show('pause');
    } else {
      this.screens.hideAll();
      this.screens.showGame();
      this.cursorMode = false;
      if (this.ui) this.ui.setCursorMode(false);
      this.requestLock();
    }
  }

  /* ============================================================
     识别机制
     ============================================================ */
  updateObservation(rawDt) {
    const p = this.player;
    const f = p.forward, eye = p.eye;
    let best = null, bestD = Infinity;

    for (const a of this.actors) {
      if (a === p || !a.alive) continue;
      const cy = a.y + (a.crouch ? 0.85 : 1.25);
      const dx = a.pos.x - eye.x, dy = cy - eye.y, dz = a.pos.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 58) continue;
      const dot = (dx * f.x + dy * f.y + dz * f.z) / d;
      if (dot < 0) continue;
      const ang = Math.acos(clamp(dot, -1, 1));
      const arc = Math.atan2(a.radius * 1.7, d) + 0.014;
      if (ang > arc) continue;
      if (d > 6 && this.losBlocked(eye.x, eye.y, eye.z, a.pos.x, cy, a.pos.z)) continue;
      if (d < bestD) { bestD = d; best = a; }
    }
    this.observeTarget = best;

    for (const a of this.actors) {
      if (a === p) continue;
      if (a.kind === 'squad') { a.seen = true; a.identified = true; a.ident = 1; continue; }
      if (!a.alive) continue;
      const dx = a.pos.x - eye.x, dz = a.pos.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d < 62) {
        const dot = (dx * f.x + dz * f.z) / (d || 1);
        if (dot > 0.28 && !this.losBlocked(eye.x, eye.y, eye.z, a.pos.x, a.y + 1.3, a.pos.z)) {
          a.seen = true;
          a.lastSeenAt = this.missionTime;
          a.lastSeenPos = { x: a.pos.x, z: a.pos.z };
          if (d < 24) a.ident = Math.max(a.ident, 0.34);
        }
      }
      if (a === best) {
        let rate = TUNING.identifyRate * (0.55 + 1.5 * clamp(1 - d / 48, 0, 1));
        if (p.ads > 0.5) rate *= TUNING.identifyRateADS;
        if (a.vel > 1.2) rate *= 1.2;
        a.ident = clamp(a.ident + rate * rawDt, 0, 1);
        if (a.ident >= 0.8 && !a.identified) {
          a.identified = true;
          this.onIdentified(a);
        }
      }
    }
  }

  onIdentified(a) {
    if (a.kind === 'suspect') {
      this.log(`识别确认 — 武装嫌疑人 ${a.name}`, 'warn');
      this.audio.radio('in');
    } else if (a.kind === 'civilian') {
      this.log('识别确认 — 平民 · 非战斗人员', 'good');
      this.ui.say(`识别为平民（${a.label}）。按 E 护送其撤离。`, null, 4);
    }
  }

  /* ============================================================
     战斗回调
     ============================================================ */
  onPlayerShot() {
    if (!this.alarmRaised) this.raiseAlarm('枪声');
    const t = this.observeTarget;
    if (!t || (t.kind !== 'squad' && !t.identified)) this.stats.blindShots++;
    if (this.viewmodel) this.viewmodel.kick(this.player.def.recoil);
    for (const s of this.suspects) {
      if (!s.alive || s.surrendered) continue;
      const d = dist2D(s.pos.x, s.pos.z, this.player.pos.x, this.player.pos.z);
      if (d < 55) {
        s.awareness = Math.max(s.awareness, 0.55);
        if (d < 34 && !s.alerted) {
          s.alerted = true;
          s.target = this.player;
          s.state = 'engage';
          this.onSuspectAlerted(s, { x: this.player.pos.x, y: 1.5, z: this.player.pos.z });
        }
      }
    }
  }

  onShotFired(shooter, hit) {
    const p = this.player;
    const d = dist2D(shooter.pos.x, shooter.pos.z, p.pos.x, p.pos.z);
    if (shooter.kind === 'suspect') {
      this.addMapEvent(shooter.pos.x, shooter.pos.z, '敌方枪声', 'gunfire');
    }
    if (shooter.kind === 'suspect' && d < 95) {
      this.audio.gunshot('mr4', d > 30);
      if (!this.alarmRaised) this.raiseAlarm('交火');
      this.alertPulse = 1;
    }
    for (const c of this.civilians) {
      if (!c.alive || c.safe) continue;
      const cd = dist2D(c.pos.x, c.pos.z, shooter.pos.x, shooter.pos.z);
      if (cd < 26) { c.threat = { x: shooter.pos.x, z: shooter.pos.z }; c.panic(); }
    }
    if (shooter.kind === 'suspect') this.weaponsFree = true;
  }

  onPlayerHit(actor, point) {
    this.ui.hit(!actor.alive);
    this.audio.click(0.2, 900);
  }

  onSuspectAlerted(s, pos) {
    this.addMapEvent(s.pos.x, s.pos.z, '发现入侵者', 'alarm');
    if (!this.alarmRaised) this.raiseAlarm('发现入侵者');
  }

  raiseAlarm(source) {
    if (this.alarmRaised) return;
    this.alarmRaised = true;
    this.weaponsFree = true;
    this.alertPulse = 1;
    this.log(`警讯 — ${source}；小队解除火力限制`, 'bad');
    this.ui.radio('敌方电台 · 白鹭', LINES.alert[Math.floor(Math.random() * LINES.alert.length)]);
    this.audio.radio('in');
    const origin = this.player.pos;
    for (const s of this.suspects) {
      if (!s.alive || s.surrendered) continue;
      const d = dist2D(s.pos.x, s.pos.z, origin.x, origin.z);
      if (d < 80 && !s.alerted) {
        s.awareness = Math.max(s.awareness, 0.6);
        setTimeout(() => {
          if (!s.alive || s.surrendered || this.state !== 'play') return;
          s.alerted = true;
          s.state = 'engage';
          s.target = this.player;
        }, 1200 + Math.random() * 2600);
      }
    }
    this.ui.say('警讯已扩散 — 嫌疑人正在收拢。保持火力纪律，别打到平民。', null, 4.5);
  }

  enemyCall(s) {
    this.ui.radio('敌方电台 · ' + COMMS.hostileNet, '有人进来了！收拢到货区，别让他们靠近调度楼。');
    this.audio.radio('in');
    this.alertPulse = 1;
  }

  squadReport(kind, member, target) {
    const dirIdx = this.bearingIndexTo(target);
    const lines = LINES[kind];
    if (!lines) return;
    const t = lines[Math.floor(Math.random() * lines.length)]
      .replace('{who}', member.callsign)
      .replace('{dir}', DIRECTIONS[dirIdx]);
    this.ui.say(t, null, 3.2);
    this.audio.radio('in');
    if (kind === 'squadIdArmed') this.log(`${member.callsign} 报告：武装嫌疑人 · ${DIRECTIONS[dirIdx]}`, 'warn');
    if (kind === 'squadIdCiv') this.log(`${member.callsign} 报告：平民 · ${DIRECTIONS[dirIdx]}`, 'good');
  }

  civilianCall(c) {
    this.addMapEvent(c.pos.x, c.pos.z, '发现平民', 'sighting');
    this.ui.say(LINES.civFound[Math.floor(Math.random() * LINES.civFound.length)], null, 3);
    this.audio.shout();
    this.log(`${c.label} 已被定位 — 按 E 护送其撤离`, '');
  }

  onSquadHurt(m) {
    this.ui.damage();
    this.audio.hurt();
  }

  onSquadDown(m) {
    this.counters.squadDown++;
    this.addMapEvent(m.pos.x, m.pos.z, '队员伤亡', 'casualty');
    this.ui.damage();
    if (m.kind === 'player') {
      this.failed = true;
      this.failReason = '队长失去行动能力';
      this.log('队长失去行动能力 —— 行动失败', 'bad');
      this.ui.say('你失去了行动能力。小队将自行脱离 —— 行动中止。', null, 4);
      this.audio.hurt();
      if (this.alarmRaised === false) this.raiseAlarm('队长伤亡');
      setTimeout(() => {
        if (this.state === 'play') this.finishMission(false);
      }, 3200);
      return;
    }
    this.log(`${m.callsign} 失去行动能力！`, 'bad');
    this.ui.say(`${m.callsign} 中弹倒地 —— 使用急救包（E）可恢复其行动能力。`, null, 5);
    this.raiseAlarm('队员伤亡');
  }

  onSuspectDown(s) {
    this.counters.killed++;
    this.addMapEvent(s.pos.x, s.pos.z, '武装人员被制止', 'casualty');
    this.log(`嫌疑人 ${s.name} 已被制止`, 'warn');
    for (const o of this.suspects) {
      if (!o.alive || o === s) continue;
      if (dist2D(o.pos.x, o.pos.z, s.pos.x, s.pos.z) < 16) {
        o.morale = Math.max(0, o.morale - 0.28);
        o.suppress(1.2, 1);
      }
    }
    this.checkSuspectsDone();
  }

  onSuspectSurrender(s) {
    this.log(`${s.name} 已投降 — 上前拘押（E）可获得更佳评估`, 'good');
    this.ui.say(LINES.surrender[Math.floor(Math.random() * LINES.surrender.length)], null, 3);
    this.audio.shout();
    for (const o of this.suspects) {
      if (!o.alive || o === s || o.surrendered) continue;
      if (dist2D(o.pos.x, o.pos.z, s.pos.x, s.pos.z) < 14) o.morale = Math.max(0, o.morale - 0.2);
    }
  }

  onDetained(s) {
    this.counters.detained++;
    this.log(`${s.name} 已被拘押`, 'good');
    this.audio.click(0.3, 1200);
    this.checkSuspectsDone();
  }

  onCivilianDown(c) {
    this.counters.civLost++;
    this.addMapEvent(c.pos.x, c.pos.z, '平民伤亡', 'casualty');
    this.failed = true;
    this.failReason = '平民伤亡';
    this.log(`平民伤亡 — ${c.label}`, 'bad');
    this.ui.say('平民出现伤亡 —— 行动已被判定为失败条件。', null, 5);
  }

  onCivilianSafe(c) {
    this.counters.civSafe++;
    this.log(`平民安全撤离 — ${c.label}（${this.counters.civSafe}/${this.civilians.length}）`, 'good');
    this.audio.chime(true);
    if (this.counters.civSafe + this.counters.civLost >= this.civilians.length) {
      this.objectiveState.civilians = this.counters.civLost === 0 ? 'done' : 'failed';
    }
    this.reevaluateExtract();
  }

  onEscortStarted(c) {
    this.log(`护送 ${c.label} — 前往南门集结区`, '');
    this.audio.click(0.24, 1100);
  }

  onObjectiveTaken(key, prop) {
    prop.taken = true;
    this.addMapEvent(prop.x, prop.z, key === 'manifest' ? '货单已取回' : '证据已提取', 'intel');
    if (prop.mesh) prop.mesh.visible = false;
    const glow = this.objectiveProps[key + 'Glow'];
    if (glow) glow.intensity = 0;
    this.objectiveState[key] = 'done';
    this.audio.chime(true);
    this.log(key === 'manifest' ? '目标完成 — 货运货单已取回' : '目标完成 — 调度室证据已提取', 'good');
    this.ui.say(key === 'manifest' ? LINES.objManifest[0] : LINES.objEvidence[0], null, 3);
    this.checkExtractReady();
  }

  checkSuspectsDone() {
    const remaining = this.suspects.filter((s) => s.alive && !s.detained && !s.surrendered).length;
    if (remaining === 0) {
      this.objectiveState.suspects = 'done';
      this.log('目标完成 — 现场武装嫌疑人已全部处理', 'good');
      this.audio.chime(true);
    }
  }

  checkExtractReady() {
    if (this.objectiveState.extract === 'active') return;
    const intel = this.objectiveState.manifest === 'done' && this.objectiveState.evidence === 'done';
    if (!intel) return;
    const civs = this.objectiveState.civilians;
    if (civs === 'active') {
      if (!this._extractHinted) {
        this._extractHinted = true;
        this.log('情报已回收 — 仍需完成平民撤离，撤离点暂未开放', 'warn');
        this.ui.radio('调度 · MERIDIAN', '情报收到。先把夜班工人带出仓区，之后返回南门撤离。');
        this.audio.radio('in');
      }
      return;
    }
    if (civs === 'done' || civs === 'failed') {
      this.objectiveState.extract = 'active';
      this.log('撤离点已激活 — 返回南门装甲车', 'good');
      this.ui.radio('调度 · MERIDIAN', '情报回收完毕。小队返回南门，装甲车已待命。');
      this.audio.radio('in');
      this.ui.say('撤离点已激活 — 南门装甲车（战术地图 Tab 可查看）', null, 5);
    }
  }

  /** 平民状态变化后重新评估撤离条件 */
  reevaluateExtract() {
    const intel = this.objectiveState.manifest === 'done' && this.objectiveState.evidence === 'done';
    if (intel && this.objectiveState.extract === 'pending') this.checkExtractReady();
  }

  finishMission(success) {
    if (this.state !== 'play') return;
    this.state = 'debrief';
    this.audio.stopAmbience();
    if (document.exitPointerLock) document.exitPointerLock();
    const res = this.buildResult(success);
    this.screens.showDebrief(res);
    this.screens.show('debrief');
    this.screens.hideGame();
    this.audio.chime(success);
  }

  buildResult(success) {
    const acc = this.stats.shots ? Math.round((this.stats.hits / this.stats.shots) * 100) : 0;
    const atLarge = this.suspects.filter((s) => s.alive && !s.detained && !s.surrendered).length;
    const handled = this.suspects.length - atLarge;
    if (handled === this.suspects.length) this.objectiveState.suspects = 'done';
    else if (handled > 0) this.objectiveState.suspects = 'active';
    if (this.objectiveState.civilians === 'active') this.objectiveState.civilians = 'failed';
    const mins = Math.floor(this.missionTime / 60), secs = Math.floor(this.missionTime % 60);

    let score = 0;
    score += this.objectiveState.manifest === 'done' ? 20 : 0;
    score += this.objectiveState.evidence === 'done' ? 20 : 0;
    score += this.counters.civLost === 0 ? 18 : -22 * this.counters.civLost;
    score += this.counters.detained * 5;
    score -= this.counters.killed * 1.5;
    score += this.counters.squadDown === 0 ? 14 : -6 * this.counters.squadDown;
    score += Math.max(0, 12 - this.stats.blindShots * 1.4);
    score += acc >= 30 ? 8 : acc >= 18 ? 4 : 0;
    if (!success) score = Math.min(score, 42);
    const grade = score >= 82 ? 'S' : score >= 68 ? 'A' : score >= 52 ? 'B' : score >= 36 ? 'C' : 'D';

    let comment;
    if (!success && this.counters.civLost > 0) {
      comment = '平民伤亡使行动失去意义。情报可以再取，人不能。下一次，把观察放在扳机之前。';
    } else if (!success && this.failReason === '队长失去行动能力') {
      comment = '队长失去行动能力，行动被迫中止。小队在无指挥状态下脱离了港区 —— 保持掩体、别把自己留在开阔地。';
    } else if (!success) {
      comment = '行动未能达成主要目标。若时间允许，先用战术暂停理清现场再推进；港区里有太多角落可以藏人。';
    } else if (this.stats.blindShots > 8) {
      comment = '射击次数不少，但多数开火发生在识别完成之前。雨幕里的轮廓会骗人 —— 用战术暂停换时间。';
    } else if (this.counters.detained >= 3) {
      comment = '优秀的武力使用控制。多数嫌疑人被活着拘押，这将直接影响后续的取证与审讯。';
    } else if (this.counters.squadDown > 0) {
      comment = '完成了任务，但代价偏高。交替掩护与掩体使用可以进一步降低伤亡。';
    } else {
      comment = '流程干净、节奏克制。小队的推进与火力纪律都符合警备处的标准作业程序。';
    }

    return {
      success, grade, comment,
      time: `${mins}:${String(secs).padStart(2, '0')}`,
      shots: this.stats.shots, accuracy: acc, blindShots: this.stats.blindShots,
      detained: this.counters.detained, killed: this.counters.killed,
      escaped: atLarge, suspectTotal: this.suspects.length,
      civSafe: this.counters.civSafe, civLost: this.counters.civLost, civTotal: this.civilians.length,
      orders: this.stats.orders, squadDown: this.counters.squadDown, gadgets: this.stats.gadgets,
      objectives: { ...this.objectiveState },
      squad: [this.player, ...this.squad].map((m) => ({
        callsign: m.callsign,
        role: m.kind === 'player' ? m.armor.name : m.tag,
        alive: m.alive, hp: m.hp, maxHp: m.maxHp,
      })),
    };
  }

  /* ============================================================
     工具
     ============================================================ */
  losBlocked(ax, ay, az, bx, by, bz) {
    return losBlocked(this.world.grid, ax, ay, az, bx, by, bz);
  }

  findCoverFor(actor, threat, dist) {
    const list = this.world.coverIdx.queryCircle(actor.pos.x, actor.pos.z, 18, []);
    let best = null, bestScore = -Infinity;
    for (const b of list) {
      const c = b.ref;
      if (!c) continue;
      const dSelf = dist2D(actor.pos.x, actor.pos.z, c.x, c.z);
      if (dSelf > 18) continue;
      const dThreat = dist2D(c.x, c.z, threat.pos.x, threat.pos.z);
      if (dThreat < 4) continue;
      const clear = !this.losBlocked(c.x, 1.3, c.z, threat.pos.x, threat.y + 1.2, threat.pos.z);
      let score = -dSelf * 1.4 - Math.abs(dThreat - dist * 0.8) * 0.5;
      if (c.box && (c.box.max.y - c.box.min.y) > 1.2) score += 6;
      if (clear) score += 3;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  bearingIndexTo(target) {
    const p = this.player;
    const ang = Math.atan2(target.pos.x - p.pos.x, -(target.pos.z - p.pos.z));
    let rel = ang - p.yaw;
    rel = ((rel + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return Math.round(((rel + TAU) % TAU) / (TAU / 12)) % 12;
  }

  playerBearing() {
    const f = this.player.forward;
    return ((Math.atan2(f.x, -f.z) * 180 / Math.PI) + 360) % 360;
  }

  markerList() {
    const out = [];
    const p = this.player;
    const bearingOf = (x, z) => ((Math.atan2(x - p.pos.x, -(z - p.pos.z)) * 180 / Math.PI) + 360) % 360;
    for (const key of ['manifest', 'evidence', 'extract']) {
      const st = this.objectiveState[key];
      if (st === 'done' && key !== 'extract') continue;
      if (key === 'extract' && st !== 'active') continue;
      const o = this.world.objectives[key];
      out.push({ bearing: bearingOf(o.x, o.z), color: '#f2b64a', shape: 'diamond', label: key === 'extract' ? 'RTB' : '' });
    }
    for (const m of this.squad) {
      if (!m.alive) continue;
      out.push({ bearing: bearingOf(m.pos.x, m.pos.z), color: '#4ea8ff', shape: 'circle', label: '' });
    }
    for (const s of this.suspects) {
      if (!s.alive || !s.identified) continue;
      out.push({ bearing: bearingOf(s.pos.x, s.pos.z), color: s.surrendered ? '#ffd479' : '#ff9a3c', shape: 'triangle', label: '' });
    }
    for (const c of this.civilians) {
      if (!c.alive || c.safe || !c.identified) continue;
      out.push({ bearing: bearingOf(c.pos.x, c.pos.z), color: '#8ee08a', shape: 'circle', label: '' });
    }
    return out;
  }

  alertLevel() {
    if (this.alarmRaised) return { text: '接敌 · 警讯已扩散', cls: 'hot' };
    if (this.suspects.some((s) => s.awareness > 0.2)) return { text: '可疑动静', cls: 'warn' };
    return { text: '安静', cls: 'calm' };
  }

  clockString() {
    const t = Math.floor(this.clock) % 86400;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  log(text, kind) { if (this.ui) this.ui.addLog(text, kind); }
  shake(mag, dur) { this.camShake = Math.max(this.camShake, mag); this.camShakeDur = dur; }

  /* ------------------------------------------------------------
     地图事件点：枪声 / 警讯 / 爆炸 / 情报 / 伤亡 …
     战术地图与小地图用黄点显示，随时间淡出
     ------------------------------------------------------------ */
  addMapEvent(x, z, label, kind = 'event') {
    if (!this.mapEvents) return;
    const now = this.missionTime;
    // 同类事件 4 秒内、且位置相近的只保留一条，避免刷屏
    for (let i = this.mapEvents.length - 1; i >= 0; i--) {
      const e = this.mapEvents[i];
      if (e.kind === kind && now - e.t < 4 && dist2D(e.x, e.z, x, z) < 8) return;
    }
    this.mapEvents.push({ x, z, label, kind, t: now });
    if (this.mapEvents.length > 14) this.mapEvents.shift();
  }

  /* ------------------------------------------------------------
     地图调试接口：window.__mapDebug
     约定：世界坐标用 (x, z)，z 即通常说的「y 轴」。
     __mapDebug.worldToMap(x, z)        → 小地图（玩家朝上，随转向旋转）
     __mapDebug.worldToMapTac(x, z)     → 战术地图（北朝上，固定）
     两者都接受 {x, z} 对象形式；返回值直接是 CSS 像素坐标。
     ------------------------------------------------------------ */
  installMapDebug() {
    const self = this;
    const arg = (a, b) => (a && typeof a === 'object') ? [a.x, a.z] : [a, b];
    window.__mapDebug = {
      get mode() { return 'minimap=player-up(rotating) / tacmap=north-up(fixed)'; },
      get yawRad() { return self.player ? self.player.yaw : 0; },
      get yawDeg() { return self.player ? +(self.player.yaw * 180 / Math.PI).toFixed(2) : 0; },
      /* 注意：本项目 yaw 减小 = 实际右转（见 player.look()），yaw 增大 = 左转 */
      get player() {
        const p = self.player;
        return p ? { x: +p.pos.x.toFixed(3), y: +p.pos.z.toFixed(3), yaw: +p.yaw.toFixed(6) } : null;
      },
      get buildings() {
        return (self.world.zones || []).map((z) => ({
          name: z.short || z.label,
          x: +((z.x0 + z.x1) / 2).toFixed(2),
          y: +((z.z0 + z.z1) / 2).toFixed(2),
        }));
      },
      get labels() {
        const t = self.tacmap;
        if (!t) return { stats: null, items: [] };
        const items = [];
        for (let i = 0; i < t.drawnN; i++) {
          const d = t.drawn[i];
          items.push({ name: d.text, x: +d.x.toFixed(1), y: +d.y.toFixed(1), w: +d.w.toFixed(1), prio: d.prio, visible: true });
        }
        return { stats: { ...t.labelStats }, items };
      },
      /* 小地图地名标签（同样带可见性统计） */
      get labelsMini() {
        const u = self.ui;
        if (!u) return { stats: null, items: [] };
        const items = [];
        for (let i = 0; i < u.drawnN; i++) {
          const d = u.drawnLabels[i];
          items.push({ name: d.text, x: +d.x.toFixed(1), y: +d.y.toFixed(1), w: +d.w.toFixed(1), visible: true });
        }
        return { stats: { ...u.labelStats }, items };
      },
      /* 世界 → 小地图像素（旋转，玩家朝上） */
      worldToMap(a, b) {
        const [x, z] = arg(a, b);
        if (!self.ui) return null;
        const o = self.ui.worldToMap(x, z, { x: 0, y: 0 });
        return { x: +o.x.toFixed(2), y: +o.y.toFixed(2) };
      },
      /* 世界 → 战术地图像素（北朝上，固定） */
      worldToMapTac(a, b) {
        const [x, z] = arg(a, b);
        if (!self.tacmap) return null;
        const o = self.tacmap.toMap(x, z);
        return { x: +o.x.toFixed(2), y: +o.y.toFixed(2) };
      },
      mapToWorld(mx, my) {
        if (!self.ui || !self.ui._k) return null;
        const p = self.player, C = self.ui._C, S = self.ui._S, k = self.ui._k;
        const u = (mx - self.ui._W / 2) / k, v = (my - self.ui._H / 2) / k;
        return { x: +(p.pos.x + C * u + S * v).toFixed(3), z: +(p.pos.z - S * u + C * v).toFixed(3) };
      },
    };
  }

  /* ============================================================
     主循环
     ============================================================ */
  /* 纯模拟步进：不渲染、不调度。正常循环与固定步长测试共用同一段逻辑，
     因此测试结果与实机行为严格一致。 */
  advance(dt, rawDt) {
    this.missionTime += dt;
    this.clock += dt * 3.2;

    for (const b of this.beats) {
      if (!b.done && this.missionTime >= b.t) { b.done = true; b.fn(); }
    }
    this.player.update(dt, this.input);
    this.input.lmbPressed = false;   // 沿信号只对本次 update 有效
    /* 调参面板的「冻结敌人 AI」开关：只跳过非玩家角色，玩家手感不受影响 */
    if (!feel.debug.freezeAI) {
      for (const a of this.actors) {
        if (a === this.player) continue;
        a.update(dt);
      }
    }
    updateProjectiles(this, dt);
    sweepProjectiles(this);
    this.effects.update(dt);
    this.world.update(dt, this.camera.position);

    this.updateObservation(rawDt);
    this.updateBound(dt);
    this.updateExtraction(dt);
    this.refreshObjectives();

    this.updateShake(rawDt);
    this.player.applyCamera(this.camera);
    this.viewmodel.update(dt, this.player, this.input);
    this.updateWeaponLight();

    this.ui.update(rawDt, this);
    if (this.tacmap.open) this.tacmap.render();
    telemetry.push(dt, Math.abs(this.player.vel), this.player.recoil.pitch, this.player.lastSpread);
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    const rawDt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    if (this.state !== 'play' || !this.scene) {
      if (this.scene && this.renderer) this.renderer.render(this.scene, this.camera);
      return;
    }
    /* 测试模式：外部以固定步长调用 advance()，结果可复现；正常游玩不受影响 */
    if (this.testMode) return;
    if (this.tuning) this.tuning.update(rawDt);


    const t0 = performance.now();
    // 帧间隔统计（含渲染），用于验收“帧率不低于 50”
    const gap = t0 - this.perf._gapT;
    this.perf._gapT = t0;
    this.perf.lastGap = gap;
    if (gap > this.perf.worstGap) this.perf.worstGap = gap;
    if (gap > 250) this.perf.stalls++;          // 明显卡顿计数
    this.perf.fps = gap > 0 ? 1000 / gap : 0;

    let ts = 1;
    if (this.paused) ts = 0;
    else if (this.tacmap.open) ts = 0.10;
    else if (this.tacticalPause) ts = TUNING.timeScalePause;
    else if (this.cursorMode) ts = 0.30;
    const dt = rawDt * ts;
    this.advance(dt, rawDt);

    /* ---- 逻辑耗时（不含渲染）：主线程是否被阻塞看这个指标 ---- */
    const t1 = performance.now();
    const logicMs = t1 - t0;
    this.perf.frames++;
    this.perf.lastLogic = logicMs;
    this.perf.logicSum += logicMs;
    this.perf.logicAvg = this.perf.logicSum / this.perf.frames;
    if (logicMs > this.perf.logicMax) this.perf.logicMax = logicMs;
    if (logicMs > 120 && !this._stallWarned) {
      this._stallWarned = true;
      console.warn('[SILENT MERIDIAN] 单帧逻辑耗时异常：' + logicMs.toFixed(1) + 'ms');
    }

    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);
    if (this.viewmodel) {
      this.renderer.autoClear = false;
      this.viewmodel.render(this.renderer);
      this.renderer.autoClear = true;
    }
    this.perf.renderMs = performance.now() - t1;

    // 把实时指标推给调试面板（按 D 唤出）
    if (window.__SM_DEBUG && t1 - this.perf._lastPush > 400) {
      this.perf._lastPush = t1;
      window.__SM_DEBUG.perf = this.perf;
      window.__SM_DEBUG.audio = this.audio.stats();
      window.__SM_DEBUG.projectiles = this.projectiles.length;
    }
  }

  updateWeaponLight() {
    if (!this.weaponLight) return;
    this.weaponLight.visible = this.lightOn;
    if (!this.lightOn) return;
    const p = this.player;
    const eye = p.eye;
    const f = p.forward;
    const right = { x: Math.cos(p.yaw), z: -Math.sin(p.yaw) };
    this.weaponLight.position.set(eye.x + f.x * 0.35 - right.x * 0.12, eye.y - 0.16, eye.z + f.z * 0.35 - right.z * 0.12);
    this.weaponLightTarget.position.set(eye.x + f.x * 26, eye.y + f.y * 26 - 0.4, eye.z + f.z * 26);
    this.weaponLightTarget.updateMatrixWorld();
  }

  updateBound(dt) {
    if (this.squadOrder !== 'clear' || !this.squadWaypoint) return;
    this.boundTimer -= dt;
    const wp = this.squadWaypoint;
    const moving = this.squad.filter((m) => m.alive && m.element === this.boundPhase);
    const arrived = moving.length > 0 && moving.every((m) => dist2D(m.pos.x, m.pos.z, wp.x, wp.z) < 3.2);
    if (arrived || this.boundTimer <= 0) {
      this.boundPhase = 1 - this.boundPhase;
      this.boundTimer = 5.5;
      for (const m of this.squad) if (m.alive) m.path = null;
    }
  }

  updateExtraction() {
    const st = this.objectiveState.extract;
    if (st !== 'active') { this.extractRing.material.opacity = 0; return; }
    this.extractRing.material.opacity = 0.32 + 0.22 * Math.sin(this.missionTime * 3);
    const ex = this.world.objectives.extract;
    const d = dist2D(this.player.pos.x, this.player.pos.z, ex.x, ex.z);
    if (d < 4.6) {
      const near = this.squad.filter((m) => m.alive && dist2D(m.pos.x, m.pos.z, ex.x, ex.z) < 16).length;
      const alive = this.squad.filter((m) => m.alive).length;
      if (near >= Math.max(1, alive - 1)) {
        this.objectiveState.extract = 'done';
        this.finishMission(!this.failed);
      } else if (this.missionTime - (this._extractWarnAt || -99) > 7) {
        this._extractWarnAt = this.missionTime;
        this.log('撤离需要小队在场 — 等待队员跟进', 'warn');
        this.ui.say('撤离需要小队在场 —— 等待队员跟进（可用「归队」或战术地图下达指令）', null, 3.4);
      }
    }
  }

  refreshObjectives() {
    if (this.objectiveState.civilians === 'active') {
      if (this.counters.civSafe + this.counters.civLost >= this.civilians.length) {
        this.objectiveState.civilians = this.counters.civLost === 0 ? 'done' : 'failed';
        this.reevaluateExtract();
      }
    }
  }

  updateShake(dt) {
    if (this.camShake > 0.001) {
      this.camShake *= Math.exp(-dt * feel.feedback.shakeDecay);
      this.camShakeY = (Math.random() - 0.5) * this.camShake * feel.feedback.shakeYaw;
      this.camShakeZ = (Math.random() - 0.5) * this.camShake * feel.feedback.shakeRoll;
    } else { this.camShake = 0; this.camShakeY = 0; this.camShakeZ = 0; }
  }
}
