/* ============================================================
   game.js — mission orchestration: order system, identification, objective flow, render loop
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
    this.renderer.setPixelRatio(canvasDpr(2));   // the real DPR is updated at any time in resize()
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    /* Note: shadow maps were once changed to "recompute on demand" (autoUpdate=false + dirty flags),
       but the measured skip rate was 0% — teammates in formation shift slightly every frame (yaw damping,
       separation pushes, aim tracking), so there is almost never a frame where every shadow caster is completely static.
       The gain was zero while requiring every future caster to remember to set a flag, so this was not adopted;
       only the texel snapping in world.update below is kept (that was a genuine image-quality fix). */
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 420);
    this.audio = new Audio();
    this.state = 'menu';
    this.timeScale = 1;
    this.paused = false;
    this.tacticalPause = false;
    /* Mission lifecycle: missionEpoch increments on every deploy(); a callback scheduled via later()
       abandons execution if the epoch has changed (or the operation is no longer running).
       _timers collects every mission-bound timer, and disposeMission() cancels them all. */
    this.missionEpoch = 0;
    this._timers = new Set();
    this._coverScratch = [];      // reused query buffer for findCoverFor
    this.rng = makeRng(991);
    this.resizeCount = 0;
    this.resize();
    /* 3. Replace onresize with ResizeObserver + DPR watching:
          covers window dragging, browser zoom (Cmd +/-) and external-display switches */
    this.sizeWatch = watchResize(document.getElementById('app') || document.body, () => this.resize());
    this.bindInput();
    this.screens = new Screens(this);
    this.tuning = new TuningPanel(this);   // feel tuning panel (summoned with P)
    this.screens.show('title');
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
    });
    this.last = performance.now();
    /* Performance instrumentation: supports the acceptance criterion "repeated flashbangs do not freeze" */
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
     Input
     ============================================================ */
  bindInput() {
    this.input = {
      keys: new Set(), lmb: false, rmb: false,
      /* lmbPressed is the "newly pressed this frame" edge signal that decides whether semi-auto / pump / revolver fires.
         It must be cleared after player.update(), otherwise it is consumed in the same frame. */
      lmbPressed: false,
    };
    const canvas = this.canvas;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.input.keys.add(e.code);
      if (e.code === 'Tab') { e.preventDefault(); if (this.state === 'play') this.toggleTacMap(); return; }
      if (e.code === 'Escape') { if (this.state === 'play') this.togglePause(true); return; }
      /* ---- Tuning-panel shortcuts (independent of game state) ---- */
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
        this.log(this.lightOn ? 'Tactical light on — observation range up, but easier to spot' : 'Tactical light off — better concealment', '');
        this.audio.click(0.2, 1500);
      }
      if (e.code === 'KeyM') {
        this.audio.setMuted(!this.audio.muted);
        this.log(this.audio.muted ? 'Audio muted' : 'Audio on', '');
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
      // Clicking the view = return to mouse look
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

    // Command-bar clicks are handled centrally by Screens' event delegation (see screens.js wire())
  }

  requestLock() {
    if (!this.canvas.requestPointerLock) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignore when there is no user gesture */ }
  }

  /**
   * Cursor mode: while the pointer is locked, the browser delivers every mouse click to the canvas,
   * so HUD buttons never receive a click. Press Alt to release the pointer and click the interface normally.
   */
  setCursorMode(on) {
    if (this.state !== 'play') return;
    if (this.tacmap && this.tacmap.open) return;
    if (this.cursorMode === on) return;
    this.cursorMode = on;
    if (on) {
      if (document.exitPointerLock) document.exitPointerLock();
      this.log('Mouse released — click the command buttons (Alt or click the view to restore look)', '');
      this.audio.click(0.16, 1400);
    } else {
      this.requestLock();
    }
    if (this.ui) this.ui.setCursorMode(on);
  }

  /* ============================================================
     Deploy mission
     ============================================================ */
  deploy(loadout) {
    this.disposeMission();
    /* Increment the epoch: even if a callback entered the event queue before clearTimers(),
       it abandons execution on the epoch mismatch (see later()). */
    this.missionEpoch++;
    this.audio.init();
    this.audio.resume();
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
    this.elementDone = [false, false];   // bounding overwatch: whether each of the two teams has reached the waypoint
    this.weaponsFree = false;
    this.alarmRaised = false;
    this.alertPulse = 0;
    this.camShake = 0; this.camShakeY = 0; this.camShakeZ = 0;
    this.cursorMode = false;
    this.tacticalPause = false;
    /* Must be reset: pause menu → "Abort and return to main menu" / "Restart" both reach deploy();
       carrying over paused=true from the previous run would keep ts at 0 in the main loop and freeze the new run completely. */
    this.paused = false;
    this._clearReported = false;
    this.missionTime = 0;
    this.clock = 23 * 3600 + 41 * 60;
    this.failed = false;
    this.failReason = '';
    this.beats = [];
    this.squadOrder = 'follow';
    this.stats = { shots: 0, hits: 0, blindShots: 0, orders: 0, gadgets: 0, revives: 0, detonations: 0 };
    this.mapEvents = [];        // map event dots (yellow)
    this.objectiveState = {
      manifest: 'active', evidence: 'active', civilians: 'active',
      suspects: 'active', extract: 'pending',
    };
    this.counters = { detained: 0, killed: 0, civLost: 0, civSafe: 0, squadDown: 0 };

    /* --- Team leader --- */
    const sp = this.world.spawns.player;
    this.player = new Player(this, { x: sp.x, z: sp.z, yaw: sp.yaw, loadout: this.loadout });
    this.actors.push(this.player);

    /* --- Squad --- */
    this.roster = [
      { callsign: 'ARDEN-2', name: 'K. Arden', tag: 'RIFLEMAN · Scout' },
      { callsign: 'BRAM-3', name: 'S. Bram', tag: 'RIFLEMAN · Support' },
      { callsign: 'CIRA-4', name: 'M. Cira', tag: 'BREACHER · Assault' },
      { callsign: 'DOV-5', name: 'L. Dov', tag: 'MEDIC · Support' },
    ];
    this.roster.forEach((r, i) => {
      const s = this.world.spawns.squad[i];
      const m = new SquadMember(this, { ...r, x: s.x, z: s.z, yaw: s.yaw }, i);
      this.squad.push(m); this.actors.push(m);
    });

    /* --- Suspects --- */
    this.world.suspects.forEach((cfg) => {
      const pos = cfg.patrol ? { x: cfg.patrol[0][0], z: cfg.patrol[0][1] } : { x: cfg.post[0], z: cfg.post[1] };
      const s = new Suspect(this, { ...cfg, x: pos.x, z: pos.z, yaw: Math.random() * TAU });
      this.suspects.push(s); this.actors.push(s);
    });

    /* --- Civilians --- */
    this.world.civilians.forEach((cfg) => {
      const c = new Civilian(this, cfg);
      this.civilians.push(c); this.actors.push(c);
    });

    /* --- Mission items --- */
    this.objectiveProps = {};
    const folder = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.26),
      new THREE.MeshStandardMaterial({ color: 0xc8b68a, roughness: 0.8 }));
    folder.position.set(-31.4, 0.87, -23.5);
    this.scene.add(folder);
    this.objectiveProps.manifest = { mesh: folder, x: -31.4, z: -23.5, label: 'Cargo manifest', taken: false };
    this.objectiveProps.manifestGlow = this.addGlow(-31.4, 1.2, -23.5);

    const drive = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x2a343d, emissive: 0x1c5f74, emissiveIntensity: 0.9, roughness: 0.5 }));
    drive.position.set(47.0, 1.42, -38.8);
    this.scene.add(drive);
    this.objectiveProps.evidence = { mesh: drive, x: 47.0, z: -38.8, label: 'Dispatch evidence', taken: false };
    this.objectiveProps.evidenceGlow = this.addGlow(47.0, 1.7, -38.8);

    this.world.objectives.manifest.x = -31.4; this.world.objectives.manifest.z = -23.5;
    this.world.objectives.evidence.x = 47.0; this.world.objectives.evidence.z = -38.8;

    /* --- Extraction / focus marker --- */
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

    /* --- Weapon tactical light --- */
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
    this.installMapDebug();
    this.state = 'play';
    this.screens.showGame();
    this.requestLock();
    this.setBeats();
    this.log('Operation started — Meridian Port, Berth 3', 'good');
    this.ui.radio('DISPATCH · MERIDIAN', 'ARDEN team, dispatch has been dark since 22:58. Enter the port and confirm the situation.');
  }

  addGlow(x, y, z) {
    const g = new THREE.PointLight(0xffd9a0, 5, 6, 2);
    g.position.set(x, y, z);
    this.scene.add(g);
    return g;
  }

  disposeMission() {
    /* Cancel leftover timers from the previous run first: otherwise, on "abort → immediately redeploy",
       old callbacks still fire, mutate discarded actor objects, and can even fail the new run outright. */
    this.clearTimers();
    /* ---- Release GPU resources that are "not in the scene graph" ----
       scene.traverse only reaches objects attached to the scene graph; the ones below escape it,
       and each redeployment measurably leaked about 8 textures, 25 geometries and several framebuffers. */
    if (this.scene) {
      if (this.scene.background && this.scene.background.dispose) this.scene.background.dispose();
      this.scene.background = null;
      this.scene.environment = null;
    }
    if (this.world) {
      if (this.world.envRT && this.world.envRT.dispose) this.world.envRT.dispose();
      if (this.world.skyTex && this.world.skyTex.dispose) this.world.skyTex.dispose();
      const L = this.world.lights;
      if (L) {
        /* The moonlight's 2048² shadow map is a render target and must be released explicitly */
        for (const key of ['moon', 'hemi']) {
          const li = L[key];
          if (li && li.shadow && li.shadow.map) { li.shadow.map.dispose(); li.shadow.map = null; }
        }
      }
      this.world = null;
    }
    if (this.viewmodel && this.viewmodel.dispose) this.viewmodel.dispose();
    this.viewmodel = null;
    this.effects = null;
    this.projectiles = [];
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
    if (this.ui) {
      this.ui.el.log.innerHTML = '';
      this.ui.el.radio.innerHTML = '';
      /* ResizeObserver must be disconnected: otherwise the old HUD (including its offscreen minimap canvas) is retained forever by the closure */
      if (this.ui.sizeWatch && this.ui.sizeWatch.disconnect) this.ui.sizeWatch.disconnect();
      this.ui = null;
    }
    if (this.tacmap) {
      this.tacmap.hide();
      this.tacmap.static = null;
      if (this.tacmap.sizeWatch && this.tacmap.sizeWatch.disconnect) this.tacmap.sizeWatch.disconnect();
      if (this.tacmap.dispose) this.tacmap.dispose();
      this.tacmap = null;
    }
  }

  abort() {
    this.disposeMission();
    this.state = 'menu';
    if (document.exitPointerLock) document.exitPointerLock();
    this.screens.hideGame();
  }

  /* ============================================================
     Mission-lifecycle-bound timers
     ------------------------------------------------------------
     Every delayed callback that can change mission state (actors, objectives, debrief) must go through here;
     do not use setTimeout directly — it is not cancelled by abort()/redeploy.
     ============================================================ */
  later(ms, fn) {
    const epoch = this.missionEpoch;
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (epoch !== this.missionEpoch || this.state !== 'play') return;
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  clearTimers() {
    if (!this._timers) return;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
  }

  setBeats() {
    this.beats = [
      { t: 4, done: false, fn: () => this.ui.radio('ARDEN-2 · K. ARDEN', 'Lead, fog is too thick — I can\'t see far past the lights. I\'ll watch, you give the order.') },
      { t: 11, done: false, fn: () => this.ui.say('Hold Space for tactical pause and time slows. Keep the crosshair on the target until identification completes — then give the order.', null, 8) },
      { t: 26, done: false, fn: () => this.ui.radio('DISPATCH · MERIDIAN', 'Be advised, night-shift workers are still on site. Do not fire before identification completes.') },
    ];
  }

  /* ============================================================
     Order system
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
        this.log('Move and clear — point too close; aim at distant ground or a target', 'warn');
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
    if (cmd === 'follow') this.log(`Order · ${name.cn} — squad following in wedge formation`, 'good');
    else if (cmd === 'hold') this.log(`Order · ${name.cn} — squad holding and watching`, 'good');
    else if (cmd === 'regroup') this.log(`Order · ${name.cn} — squad closing up`, 'good');
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
   * Callback when a member reaches the "move and clear" waypoint (called by SquadMember).
   * Note: this method used to be called without ever being defined — the moment a member arrived it threw
   * a TypeError and aborted the entire simulation loop. This method must always exist.
   */
  onElementArrived(member) {
    if (this.squadOrder !== 'clear' || !this.squadWaypoint) return;
    const wp = this.squadWaypoint;
    if (dist2D(member.pos.x, member.pos.z, wp.x, wp.z) >= 3.5) return;
    this.elementDone[member.element] = true;      // bounding overwatch: this team is on point
    const alive = this.squad.filter((m) => m.alive);
    const allOnPoint = alive.length > 0 &&
      alive.every((m) => dist2D(m.pos.x, m.pos.z, wp.x, wp.z) < 3.5);
    if (allOnPoint && !this._clearReported) {
      this._clearReported = true;
      this.log('Area clear — squad reached the waypoint', 'good');
      this.audio.radio('in');
      this.ui.say('ARDEN: Clear, area secure.', null, 2.4);
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
    this.log(`Order · MOVE & CLEAR — objective ${d}m out, advancing by bounding overwatch`, 'good');
    this.audio.radio('out');
    this.ui.say('ARDEN: Copy, bounding forward.', null, 2.4);
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
     Tactical pause / map / pause
     ============================================================ */
  setTacticalPause(on) {
    if (this.state !== 'play' || (this.tacmap && this.tacmap.open)) return;
    if (this.tacticalPause === on) return;
    this.tacticalPause = on;
    if (on) {
      this.audio.radio('in');
      this.ui.say('Tactical pause — observe, order, then act', null, 2);
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
     Identification
     ------------------------------------------------------------
     Time-base note (deliberate; do not casually change this to dt):
       · Identification advances on rawDt (real time), so under "tactical pause" (time at 10%)
         it still completes at full speed — exactly what the README promises:
         "Hold Space to enter tactical pause and complete identification and issue orders without taking risks."
       · But the pause menu (ts = 0) must truly freeze, otherwise while you sit in the menu
         the identification progress on the battlefield fills up on its own.
       · Same when the tactical map is open: the operator is on the map and should not keep accumulating identification.
     ============================================================ */
  updateObservation(rawDt) {
    if (this.paused || (this.tacmap && this.tacmap.open)) return;
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
      this.log(`Identification confirmed — ARMED SUSPECT ${a.name}`, 'warn');
      this.audio.radio('in');
    } else if (a.kind === 'civilian') {
      this.log('Identification confirmed — CIVILIAN · NON-COMBATANT', 'good');
      this.ui.say(`Identified as civilian (${a.label}). Press E to escort them out.`, null, 4);
    }
  }

  /* ============================================================
     Combat callbacks
     ============================================================ */
  onPlayerShot() {
    if (!this.alarmRaised) this.raiseAlarm('gunfire');
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
      this.addMapEvent(shooter.pos.x, shooter.pos.z, 'Hostile gunfire', 'gunfire');
    }
    if (shooter.kind === 'suspect' && d < 95) {
      this.audio.gunshot('mr4', d > 30);
      if (!this.alarmRaised) this.raiseAlarm('exchange of fire');
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
    this.addMapEvent(s.pos.x, s.pos.z, 'Intruder spotted', 'alarm');
    if (!this.alarmRaised) this.raiseAlarm('intruder spotted');
  }

  raiseAlarm(source) {
    if (this.alarmRaised) return;
    this.alarmRaised = true;
    this.weaponsFree = true;
    this.alertPulse = 1;
    this.log(`ALERT — ${source}; squad weapons free`, 'bad');
    this.ui.radio('HOSTILE RADIO · EGRET', LINES.alert[Math.floor(Math.random() * LINES.alert.length)]);
    this.audio.radio('in');
    const origin = this.player.pos;
    for (const s of this.suspects) {
      if (!s.alive || s.surrendered) continue;
      const d = dist2D(s.pos.x, s.pos.z, origin.x, origin.z);
      if (d < 80 && !s.alerted) {
        s.awareness = Math.max(s.awareness, 0.6);
        this.later(1200 + Math.random() * 2600, () => {
          if (!s.alive || s.surrendered) return;
          s.alerted = true;
          s.state = 'engage';
          s.target = this.player;
        });
      }
    }
    this.ui.say('Alert has spread — suspects are closing up. Keep fire discipline, watch for civilians.', null, 4.5);
  }

  enemyCall(s) {
    this.ui.radio('HOSTILE RADIO · ' + COMMS.hostileNet, 'Someone\'s inside! Close up on the cargo area, don\'t let them near dispatch.');
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
    if (kind === 'squadIdArmed') this.log(`${member.callsign} reports: ARMED SUSPECT · ${DIRECTIONS[dirIdx]}`, 'warn');
    if (kind === 'squadIdCiv') this.log(`${member.callsign} reports: CIVILIAN · ${DIRECTIONS[dirIdx]}`, 'good');
  }

  civilianCall(c) {
    this.addMapEvent(c.pos.x, c.pos.z, 'Civilian found', 'sighting');
    this.ui.say(LINES.civFound[Math.floor(Math.random() * LINES.civFound.length)], null, 3);
    this.audio.shout();
    this.log(`${c.label} located — press E to escort them out`, '');
  }

  onSquadHurt(m) {
    this.ui.damage();
    this.audio.hurt();
  }

  onSquadDown(m) {
    this.counters.squadDown++;
    this.addMapEvent(m.pos.x, m.pos.z, 'Teammate casualty', 'casualty');
    this.ui.damage();
    if (m.kind === 'player') {
      this.failed = true;
      this.failReason = 'team leader incapacitated';
      this.log('Team leader incapacitated — operation failed', 'bad');
      this.ui.say('You are down. The squad is breaking contact on its own — operation aborted.', null, 4);
      this.audio.hurt();
      if (this.alarmRaised === false) this.raiseAlarm('team leader down');
      this.later(3200, () => this.finishMission(false));
      return;
    }
    this.log(`${m.callsign} is down!`, 'bad');
    this.ui.say(`${m.callsign} is hit and down — use a trauma kit (E) to get them back up.`, null, 5);
    this.raiseAlarm('teammate down');
  }

  onSuspectDown(s) {
    this.counters.killed++;
    this.addMapEvent(s.pos.x, s.pos.z, 'Armed man stopped', 'casualty');
    this.log(`Suspect ${s.name} stopped`, 'warn');
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
    this.log(`${s.name} has surrendered — move in and detain (E) for a better assessment`, 'good');
    this.ui.say(LINES.surrender[Math.floor(Math.random() * LINES.surrender.length)], null, 3);
    this.audio.shout();
    for (const o of this.suspects) {
      if (!o.alive || o === s || o.surrendered) continue;
      if (dist2D(o.pos.x, o.pos.z, s.pos.x, s.pos.z) < 14) o.morale = Math.max(0, o.morale - 0.2);
    }
  }

  onDetained(s) {
    this.counters.detained++;
    this.log(`${s.name} detained`, 'good');
    this.audio.click(0.3, 1200);
    this.checkSuspectsDone();
  }

  onCivilianDown(c) {
    this.counters.civLost++;
    this.addMapEvent(c.pos.x, c.pos.z, 'Civilian casualty', 'casualty');
    this.failed = true;
    this.failReason = 'civilian casualties';
    this.log(`Civilian casualty — ${c.label}`, 'bad');
    this.ui.say('A civilian has been hit — the operation is now a failure.', null, 5);
  }

  onCivilianSafe(c) {
    this.counters.civSafe++;
    this.log(`Civilian safely evacuated — ${c.label} (${this.counters.civSafe}/${this.civilians.length})`, 'good');
    this.audio.chime(true);
    if (this.counters.civSafe + this.counters.civLost >= this.civilians.length) {
      this.objectiveState.civilians = this.counters.civLost === 0 ? 'done' : 'failed';
    }
    this.reevaluateExtract();
  }

  onEscortStarted(c) {
    this.log(`Escorting ${c.label} — moving to the south gate rally point`, '');
    this.audio.click(0.24, 1100);
  }

  onObjectiveTaken(key, prop) {
    prop.taken = true;
    this.addMapEvent(prop.x, prop.z, key === 'manifest' ? 'Manifest recovered' : 'Evidence extracted', 'intel');
    if (prop.mesh) prop.mesh.visible = false;
    const glow = this.objectiveProps[key + 'Glow'];
    if (glow) glow.intensity = 0;
    this.objectiveState[key] = 'done';
    this.audio.chime(true);
    this.log(key === 'manifest' ? 'Objective complete — cargo manifest recovered' : 'Objective complete — dispatch evidence extracted', 'good');
    this.ui.say(key === 'manifest' ? LINES.objManifest[0] : LINES.objEvidence[0], null, 3);
    this.checkExtractReady();
  }

  checkSuspectsDone() {
    const remaining = this.suspects.filter((s) => s.alive && !s.detained && !s.surrendered).length;
    if (remaining === 0) {
      this.objectiveState.suspects = 'done';
      this.log('Objective complete — all armed suspects on site handled', 'good');
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
        this.log('Intel recovered — civilian evacuation still pending; extraction point not yet open', 'warn');
        this.ui.radio('DISPATCH · MERIDIAN', 'Intel received. Get the night-shift workers out of the warehouse district first, then return to the south gate for extraction.');
        this.audio.radio('in');
      }
      return;
    }
    if (civs === 'done' || civs === 'failed') {
      this.objectiveState.extract = 'active';
      this.log('Extraction point active — return to the south gate armored vehicle', 'good');
      this.ui.radio('DISPATCH · MERIDIAN', 'Intel recovery complete. Squad return to the south gate; the armored vehicle is standing by.');
      this.audio.radio('in');
      this.ui.say('Extraction point active — south gate armored vehicle (view on the tactical map, Tab)', null, 5);
    }
  }

  /** Re-evaluate extraction conditions after a civilian status change */
  reevaluateExtract() {
    const intel = this.objectiveState.manifest === 'done' && this.objectiveState.evidence === 'done';
    if (intel && this.objectiveState.extract === 'pending') this.checkExtractReady();
  }

  finishMission(success) {
    if (this.state !== 'play') return;
    this.state = 'debrief';
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
      comment = 'Civilian casualties make the operation meaningless. Intelligence can be recovered again; people cannot. Next time, put observation before the trigger.';
    } else if (!success && this.failReason === 'team leader incapacitated') {
      comment = 'The team leader was incapacitated and the operation had to be aborted. The squad broke contact without command — stay behind cover and never leave yourself in the open.';
    } else if (!success) {
      comment = 'The operation failed to achieve its primary objectives. If time allows, use tactical pause to sort out the situation before advancing; this port has too many corners where people can hide.';
    } else if (this.stats.blindShots > 8) {
      comment = 'You fired a great deal, but most of it before identification was complete. Silhouettes in fog lie — trade time for certainty with tactical pause.';
    } else if (this.counters.detained >= 3) {
      comment = 'Excellent control of force. Most suspects were taken alive, which will directly affect the evidence and interrogation work that follows.';
    } else if (this.counters.squadDown > 0) {
      comment = 'The mission was completed, but at a high cost. Bounding overwatch and better use of cover can further reduce casualties.';
    } else {
      comment = 'Clean process and restrained tempo. The squad\'s movement and fire discipline met the Security Office standard operating procedure.';
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
     Utilities
     ============================================================ */
  losBlocked(ax, ay, az, bx, by, bz) {
    return losBlocked(this.world.grid, ax, ay, az, bx, by, bz);
  }

  findCoverFor(actor, threat, dist) {
    const list = this.world.coverIdx.queryCircle(actor.pos.x, actor.pos.z, 18, this._coverScratch);
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
    if (this.alarmRaised) return { text: 'CONTACT · ALERT SPREADING', cls: 'hot' };
    if (this.suspects.some((s) => s.awareness > 0.2)) return { text: 'SUSPICIOUS MOVEMENT', cls: 'warn' };
    return { text: 'QUIET', cls: 'calm' };
  }

  clockString() {
    const t = Math.floor(this.clock) % 86400;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  log(text, kind) { if (this.ui) this.ui.addLog(text, kind); }
  shake(mag, dur) { this.camShake = Math.max(this.camShake, mag); this.camShakeDur = dur; }

  /* ------------------------------------------------------------
     Map event dots: gunfire / alarm / explosion / intel / casualty …
     Shown as yellow dots on the tactical map and minimap, fading over time
     ------------------------------------------------------------ */
  addMapEvent(x, z, label, kind = 'event') {
    if (!this.mapEvents) return;
    const now = this.missionTime;
    // Keep only one event of the same kind within 4 seconds and near the same position, to avoid flooding
    for (let i = this.mapEvents.length - 1; i >= 0; i--) {
      const e = this.mapEvents[i];
      if (e.kind === kind && now - e.t < 4 && dist2D(e.x, e.z, x, z) < 8) return;
    }
    this.mapEvents.push({ x, z, label, kind, t: now });
    if (this.mapEvents.length > 14) this.mapEvents.shift();
  }

  /* ------------------------------------------------------------
     Map debug interface: window.__mapDebug
     Convention: world coordinates use (x, z), where z is what is usually called the "y axis".
     __mapDebug.worldToMap(x, z)        → minimap (player-up, rotating with heading)
     __mapDebug.worldToMapTac(x, z)     → tactical map (north-up, fixed)
     Both accept {x, z} objects; return values are CSS pixel coordinates.
     ------------------------------------------------------------ */
  installMapDebug() {
    const self = this;
    const arg = (a, b) => (a && typeof a === 'object') ? [a.x, a.z] : [a, b];
    window.__mapDebug = {
      get mode() { return 'minimap=player-up(rotating) / tacmap=north-up(fixed)'; },
      get yawRad() { return self.player ? self.player.yaw : 0; },
      get yawDeg() { return self.player ? +(self.player.yaw * 180 / Math.PI).toFixed(2) : 0; },
      /* Note: in this project decreasing yaw = actually turning right (see player.look()), increasing yaw = turning left */
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
      /* Minimap place-name labels (with the same visibility stats) */
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
      /* World → minimap pixels (rotated, player-up) */
      worldToMap(a, b) {
        const [x, z] = arg(a, b);
        if (!self.ui) return null;
        const o = self.ui.worldToMap(x, z, { x: 0, y: 0 });
        return { x: +o.x.toFixed(2), y: +o.y.toFixed(2) };
      },
      /* World → tactical map pixels (north-up, fixed) */
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
     Main loop
     ============================================================ */
  /* Pure simulation step: no rendering, no scheduling. The normal loop and fixed-timestep tests share this exact logic,
     so test results match real gameplay behavior precisely. */
  advance(dt, rawDt) {
    this.missionTime += dt;
    this.clock += dt * 3.2;

    for (const b of this.beats) {
      if (!b.done && this.missionTime >= b.t) { b.done = true; b.fn(); }
    }
    this.player.update(dt, this.input);
    this.input.lmbPressed = false;   // the edge signal is valid only for this update
    /* Tuning panel's "freeze enemy AI" toggle: skips only non-player characters, so player feel is unaffected */
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
    this.player.applyCamera(this.camera, dt);
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
    /* Test mode: advance() is driven externally at a fixed timestep for reproducible results; normal play is unaffected */
    if (this.testMode) return;
    if (this.tuning) this.tuning.update(rawDt);


    const t0 = performance.now();
    // Frame-gap stats (including rendering), supporting the "frame rate not below 50" acceptance criterion
    const gap = t0 - this.perf._gapT;
    this.perf._gapT = t0;
    this.perf.lastGap = gap;
    if (gap > this.perf.worstGap) this.perf.worstGap = gap;
    if (gap > 250) this.perf.stalls++;          // count obvious stalls
    this.perf.fps = gap > 0 ? 1000 / gap : 0;

    let ts = 1;
    if (this.paused) ts = 0;
    else if (this.tacmap.open) ts = 0.10;
    else if (this.tacticalPause) ts = TUNING.timeScalePause;
    else if (this.cursorMode) ts = 0.30;
    const dt = rawDt * ts;
    this.advance(dt, rawDt);

    /* ---- Logic time (excluding rendering): this is the metric for whether the main thread is blocked ---- */
    const t1 = performance.now();
    const logicMs = t1 - t0;
    this.perf.frames++;
    this.perf.lastLogic = logicMs;
    this.perf.logicSum += logicMs;
    this.perf.logicAvg = this.perf.logicSum / this.perf.frames;
    if (logicMs > this.perf.logicMax) this.perf.logicMax = logicMs;
    if (logicMs > 120 && !this._stallWarned) {
      this._stallWarned = true;
      console.warn('[SILENT MERIDIAN] Abnormal single-frame logic time: ' + logicMs.toFixed(1) + 'ms');
    }

    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);
    if (this.viewmodel) {
      this.renderer.autoClear = false;
      this.viewmodel.render(this.renderer);
      this.renderer.autoClear = true;
    }
    this.perf.renderMs = performance.now() - t1;

    // Push live metrics to the debug panel (opened with D)
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
    /* Both teams have advanced into position ⇒ bounding overwatch complete.
       Previously elementDone was only written, never read, so this flipped the phase every 5.5s forever
       and repeatedly cleared the paths of members already in position. */
    if (this.elementDone[0] && this.elementDone[1]) return;
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
        this.log('Extraction requires the squad on site — waiting for members to catch up', 'warn');
        this.ui.say('Extraction requires the squad on site — waiting for members to catch up (use REGROUP or the tactical map)', null, 3.4);
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

  /* Screen shake decays on real time (rawDt), independent of timeScale — deliberately:
     shake is pure visual feedback; freezing it halfway during a pause would leave the view trembling behind the pause menu.
     The parameter name and call sites are uniformly rawDt, to avoid misreading it as a dt already scaled by timeScale. */
  updateShake(rawDt) {
    if (this.camShake > 0.001) {
      this.camShake *= Math.exp(-rawDt * feel.feedback.shakeDecay);
      this.camShakeY = (Math.random() - 0.5) * this.camShake * feel.feedback.shakeYaw;
      this.camShakeZ = (Math.random() - 0.5) * this.camShake * feel.feedback.shakeRoll;
    } else { this.camShake = 0; this.camShakeY = 0; this.camShakeZ = 0; }
  }
}
