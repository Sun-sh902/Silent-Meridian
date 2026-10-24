/* ============================================================
   audio.js — procedural sound (no external assets, everything synthesised with WebAudio)
   ------------------------------------------------------------
   Design constraints (from the issue list):
     1) exactly one AudioContext: module-level singleton, a second one is never created
     2) no node leaks: each voice disconnects and drops its references in onended after stop
     3) never block the main thread: the white-noise buffer is built once, in async chunks
     4) no per-pixel visuals: this file takes no part in rendering (see the pure-CSS whiteout in hud.js)
     5) no clicks: every gain change goes through a ramp (>=5 ms), never an instant assignment
     6) limiting: master → DynamicsCompressor (limiter) → output gain 0.8 → destination
   ============================================================ */

/* ---------------- 1. The single global AudioContext ---------------- */
let SHARED_CTX = null;
let CTX_CREATED = 0;

function acquireContext() {
  if (SHARED_CTX && SHARED_CTX.state !== 'closed') return SHARED_CTX;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  SHARED_CTX = new AC();
  CTX_CREATED++;
  return SHARED_CTX;
}

const MAX_VOICES = 40;        // cap on simultaneously sounding voices, prevents avalanches
const RAMP_MS = 8;            // minimum fade in/out time

export class Audio {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.ctx = null;
    this.noise = null;
    this.noiseReady = false;
    this._noiseTimer = null;
    this._last = Object.create(null);
    this._gatedCount = 0;
    this._droppedCount = 0;
    this.live = new Set();       // currently sounding nodes (diagnostics)
  }

  /* ============================================================
     Initialisation
     ============================================================ */
  init() {
    if (this.ready) return;
    const ctx = acquireContext();
    if (!ctx) return;
    this.ctx = ctx;

    /* ---- 6. main output chain: master → limiter → output gain (0.8) → destination ---- */
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0.0001 : 0.9;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -9;    // dBFS
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;        // close to a hard limit
    this.limiter.attack.value = 0.003;    // 3ms
    this.limiter.release.value = 0.22;

    this.out = ctx.createGain();
    this.out.gain.value = 0.8;            // peak ceiling 0.8

    this.master.connect(this.limiter);
    this.limiter.connect(this.out);
    this.out.connect(ctx.destination);

    this.ready = true;
    this._buildNoiseBuffer();             // 3. built in chunks, non-blocking
    // init() only builds the graph: menu buttons need sound too, but no continuous ambience starts here.

    // 1. resume inside the first user gesture (browser autoplay policy)
    const gesture = () => this.resume();
    window.addEventListener('pointerdown', gesture, { passive: true });
    window.addEventListener('keydown', gesture, { passive: true });
    this._gestureHandler = gesture;
    this.resume();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setMuted(m) {
    this.muted = m;
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    // 5. mute/unmute must ramp too, to avoid clicks
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.0001), t);
    g.exponentialRampToValueAtTime(m ? 0.0001 : 0.9, t + 0.03);
  }

  /* ============================================================
     3. white-noise buffer: built once, in async chunks
     ============================================================ */
  _buildNoiseBuffer() {
    if (this.noise || this._noiseTimer) return;
    const sr = this.ctx.sampleRate;
    const total = Math.floor(sr * 1.5);          // 1.5 s mono, enough to loop
    const buf = this.ctx.createBuffer(1, total, sr);
    const data = buf.getChannelData(0);
    const CHUNK = 16384;
    let i = 0;
    const step = () => {
      const end = Math.min(total, i + CHUNK);
      for (; i < end; i++) data[i] = Math.random() * 2 - 1;
      if (i < total) {
        this._noiseTimer = setTimeout(step, 0);  // yield the main thread
      } else {
        this._noiseTimer = null;
        this.noise = buf;                        // every later sound reuses this buffer
        this.noiseReady = true;
      }
    };
    step();
  }

  _noiseSource(rate = 1, loop = false) {
    if (!this.noise) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    s.playbackRate.value = rate;
    return s;
  }

  /* ============================================================
     2. voice lifecycle: stop + disconnect in onended
     ============================================================ */
  _v(src, nodes) {
    const all = [src].concat(nodes || []);
    for (const n of all) this.live.add(n);
    src.onended = () => {
      for (const n of all) {
        try { n.disconnect(); } catch (e) { /* already disconnected */ }
        this.live.delete(n);
      }
    };
    return src;
  }

  _budget() {
    if (this.live.size >= MAX_VOICES) { this._droppedCount++; return false; }
    return true;
  }

  /** minimum interval per named sound, so a pile-up can't howl or clip */
  _gate(name, ms) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (this._last[name] && now - this._last[name] < ms) { this._gatedCount++; return false; }
    this._last[name] = now;
    return true;
  }

  /* ============================================================
     5. gain envelopes: always ramped, minimum 5 ms
     ============================================================ */
  _env(param, t, peak, attackMs, decayMs) {
    const atk = Math.max(attackMs, 5) / 1000;
    const rel = Math.max(decayMs, 5) / 1000;
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + atk);
    param.exponentialRampToValueAtTime(0.0001, t + atk + rel);
  }

  /* ============================================================
     Gunshot
     ============================================================ */
  gunshot(id, distant = false) {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    const heavy = id === 'vk12' || id === 'r7';
    const quiet = id === 'p9' || id === 'k9';
    const gainScale = distant ? 0.45 : 1;

    // crack
    const src = this._noiseSource(1);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.setValueAtTime(heavy ? 4200 : 6200, t);
    bp.frequency.exponentialRampToValueAtTime(420, t + 0.16);
    const g = this.ctx.createGain();
    this._env(g.gain, t, (quiet ? 0.26 : 0.38) * gainScale, 5, heavy ? 300 : 180);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    this._v(src, [bp, g]);
    src.start(t); src.stop(t + 0.5);

    // low-frequency body
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(heavy ? 120 : 165, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.13);
    const og = this.ctx.createGain();
    this._env(og.gain, t, (heavy ? 0.26 : 0.15) * gainScale, 5, 140);
    osc.connect(og); og.connect(this.master);
    this._v(osc, [og]);
    osc.start(t); osc.stop(t + 0.3);

    // tail
    const tail = this._noiseSource(0.5);
    const tf = this.ctx.createBiquadFilter();
    tf.type = 'bandpass'; tf.frequency.value = 1100; tf.Q.value = 0.7;
    const tg = this.ctx.createGain();
    this._env(tg.gain, t + 0.02, 0.08 * gainScale, 12, 320);
    tail.connect(tf); tf.connect(tg); tg.connect(this.master);
    this._v(tail, [tf, tg]);
    tail.start(t); tail.stop(t + 0.6);
  }

  distantShot() { this.gunshot('mr4', true); }

  dryFire() { this.click(0.4, 2400); }

  click(vol = 0.3, freq = 1800) {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource(1);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 3;
    const g = this.ctx.createGain();
    this._env(g.gain, t, vol, 5, 40);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    this._v(src, [bp, g]);
    src.start(t); src.stop(t + 0.1);
  }

  reloadStart() { this.click(0.28, 900); setTimeout(() => this.click(0.22, 1400), 320); }
  reloadDone() { setTimeout(() => this.click(0.3, 1900), 0); setTimeout(() => this.click(0.26, 2400), 90); }

  footstep(surface = 0) {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource(0.6);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 380 + surface * 260; bp.Q.value = 1.1;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.06, 5, 70);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    this._v(src, [bp, g]);
    src.start(t); src.stop(t + 0.2);
  }

  radio(kind = 'in') {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = kind === 'in' ? 1150 : 880;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 2200;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.05, 6, 100);
    osc.connect(f); f.connect(g); g.connect(this.master);
    this._v(osc, [f, g]);
    osc.start(t); osc.stop(t + 0.2);

    const n = this._noiseSource(1.4);
    const ng = this.ctx.createGain();
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 1800;
    this._env(ng.gain, t, 0.026, 6, 85);
    n.connect(nf); nf.connect(ng); ng.connect(this.master);
    this._v(n, [nf, ng]);
    n.start(t); n.stop(t + 0.2);
  }

  chime(up = true) {
    if (!this.ready || this.muted) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    [0, 0.09].forEach((off, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = up ? (i ? 880 : 660) : (i ? 520 : 660);
      const g = this.ctx.createGain();
      this._env(g.gain, t + off, 0.09, 12, 320);
      osc.connect(g); g.connect(this.master);
      this._v(osc, [g]);
      osc.start(t + off); osc.stop(t + off + 0.5);
    });
  }

  throwItem() { this.click(0.2, 700); }

  /* ============================================================
     6. Flashbang: overall level kept low, tinnitus tone not piercing
     ============================================================ */
  flashbang() {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    if (!this._gate('flash', 150)) return;      // back-to-back detonations don't stack into a howl
    const t = this.ctx.currentTime;

    // shockwave
    const src = this._noiseSource(1);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(7000, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 1.0);
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.42, 5, 780);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    this._v(src, [lp, g]);
    src.start(t); src.stop(t + 1.3);

    // low-frequency body
    const boom = this.ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(130, t);
    boom.frequency.exponentialRampToValueAtTime(42, t + 0.34);
    const bg = this.ctx.createGain();
    this._env(bg.gain, t, 0.3, 6, 340);
    boom.connect(bg); bg.connect(this.master);
    this._v(boom, [bg]);
    boom.start(t); boom.stop(t + 0.5);

    // tinnitus: pitched down to 2.2 kHz with a softening low-pass, level 0.028, fast decay
    const ring = this.ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.setValueAtTime(2200, t + 0.02);
    ring.frequency.exponentialRampToValueAtTime(1750, t + 1.6);
    const ringLp = this.ctx.createBiquadFilter();
    ringLp.type = 'lowpass'; ringLp.frequency.value = 3000; ringLp.Q.value = 0.6;
    const rg = this.ctx.createGain();
    this._env(rg.gain, t + 0.02, 0.028, 20, 1500);   // 20 ms fade-in, avoids an attack pop
    ring.connect(ringLp); ringLp.connect(rg); rg.connect(this.master);
    this._v(ring, [ringLp, rg]);
    ring.start(t + 0.02); ring.stop(t + 1.8);
  }

  boom(scale = 1) {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    if (!this._gate('boom', 120)) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource(0.35);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.8);
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.5 * scale, 6, 1000 * scale);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    this._v(src, [lp, g]);
    src.start(t); src.stop(t + 1.4);
  }

  hurt() {
    if (!this.ready || this.muted) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.3);
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.2, 6, 320);
    osc.connect(g); g.connect(this.master);
    this._v(osc, [g]);
    osc.start(t); osc.stop(t + 0.5);
  }

  shout() {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource(0.7);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(420, t);
    f.frequency.linearRampToValueAtTime(240, t + 0.4);
    f.Q.value = 4;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.12, 20, 400);
    src.connect(f); f.connect(g); g.connect(this.master);
    this._v(src, [f, g]);
    src.start(t); src.stop(t + 0.6);
  }

  /* ============================================================
     Diagnostics: for the stress test and the debug panel
     ============================================================ */
  stats() {
    return {
      ctxCount: CTX_CREATED,          // must always be 1
      ctxState: this.ctx ? this.ctx.state : 'none',
      liveNodes: this.live.size,
      noiseReady: this.noiseReady,
      gated: this._gatedCount,
      dropped: this._droppedCount,
      voices: this.live.size,
    };
  }
}
