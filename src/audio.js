/* ============================================================
   audio.js — 程序化音效（无外部资源，全部 WebAudio 合成）
   ------------------------------------------------------------
   设计约束（对应问题清单）：
     1) AudioContext 全局唯一：模块级单例，任何情况下都不会 new 出第二个
     2) 节点不泄漏：每个 voice 在 stop 后 onended 里 disconnect 并释放引用
     3) 不阻塞主线程：白噪声缓冲只生成一次，且分块异步生成
     4) 视觉不逐像素：本文件不参与渲染（见 hud.js 的纯 CSS 白屏）
     5) 无爆音：所有增益变化都走 ramp（>=5ms），禁止瞬时赋值
     6) 限幅：master → DynamicsCompressor(限幅) → 输出增益 0.8 → destination
   ============================================================ */

/* ---------------- 1. 全局唯一的 AudioContext ---------------- */
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

const MAX_VOICES = 40;        // 同时在发声的 voice 上限，防止雪崩
const RAMP_MS = 8;            // 最小淡入淡出时长

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
    this.live = new Set();       // 正在发声的节点（诊断用）
    this.rainNodes = null;
    this._ambience = false;      // 环境声是否应当开启（仅行动中为 true）
  }

  /* ============================================================
     初始化
     ============================================================ */
  init() {
    if (this.ready) return;
    const ctx = acquireContext();
    if (!ctx) return;
    this.ctx = ctx;

    /* ---- 6. 主输出链：master → 限幅器 → 输出增益(0.8) → destination ---- */
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0.0001 : 0.9;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -9;    // dBFS
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;        // 接近硬限幅
    this.limiter.attack.value = 0.003;    // 3ms
    this.limiter.release.value = 0.22;

    this.out = ctx.createGain();
    this.out.gain.value = 0.8;            // 峰值上限 0.8

    this.master.connect(this.limiter);
    this.limiter.connect(this.out);
    this.out.connect(ctx.destination);

    this.ready = true;
    this._buildNoiseBuffer();             // 3. 分块生成，不阻塞
    // 注意：这里不再启动环境声。init() 只负责建图（菜单里点按钮也需要音效），
    // 雨声必须由 startAmbience() 显式开启，否则备战界面就会听到港区环境音。

    // 1. 首次用户手势里 resume（浏览器自动播放策略）
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
    // 5. 静音/取消静音也必须 ramp，避免咔哒
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.0001), t);
    g.exponentialRampToValueAtTime(m ? 0.0001 : 0.9, t + 0.03);
  }

  /* ============================================================
     3. 白噪声缓冲：只生成一次 + 分块异步
     ============================================================ */
  _buildNoiseBuffer() {
    if (this.noise || this._noiseTimer) return;
    const sr = this.ctx.sampleRate;
    const total = Math.floor(sr * 1.5);          // 1.5 秒单声道，足够循环复用
    const buf = this.ctx.createBuffer(1, total, sr);
    const data = buf.getChannelData(0);
    const CHUNK = 16384;
    let i = 0;
    const step = () => {
      const end = Math.min(total, i + CHUNK);
      for (; i < end; i++) data[i] = Math.random() * 2 - 1;
      if (i < total) {
        this._noiseTimer = setTimeout(step, 0);  // 让出主线程
      } else {
        this._noiseTimer = null;
        this.noise = buf;                        // 之后所有声音复用同一个 buffer
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
     2. voice 生命周期：stop + onended 里 disconnect
     ============================================================ */
  _v(src, nodes) {
    const all = [src].concat(nodes || []);
    for (const n of all) this.live.add(n);
    src.onended = () => {
      for (const n of all) {
        try { n.disconnect(); } catch (e) { /* 已断开 */ }
        this.live.delete(n);
      }
    };
    return src;
  }

  _budget() {
    if (this.live.size >= MAX_VOICES) { this._droppedCount++; return false; }
    return true;
  }

  /** 同名音效最小间隔，避免同时叠一堆造成啸叫/削波 */
  _gate(name, ms) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (this._last[name] && now - this._last[name] < ms) { this._gatedCount++; return false; }
    this._last[name] = now;
    return true;
  }

  /* ============================================================
     5. 增益包络：全部带 ramp，最小 5ms
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
     持续音：雨
     ============================================================ */
  /** 进入行动时才开启环境声 */
  startAmbience() {
    if (!this.ready) this.init();
    this._ambience = true;
    this.startRain();
  }

  /** 离开行动时淡出并彻底断开环境声节点 */
  stopAmbience() {
    this._ambience = false;
    if (!this.rainNodes || !this.ctx) return;
    const { src, g, hp, lp, lfo, lfoG } = this.rainNodes;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);   // 淡出，避免爆音
    [src, lfo].forEach((n) => { try { n.stop(t + 0.4); } catch (e) { /* 已停止 */ } });
    this.rainNodes = null;
    setTimeout(() => {
      [src, g, hp, lp, lfo, lfoG].forEach((n) => {
        try { n.disconnect(); } catch (e) { /* 已断开 */ }
        this.live.delete(n);
      });
    }, 500);
  }

  startRain() {
    if (!this.ready || this.rainNodes || !this._ambience) return;
    const src = this._noiseSource(0.85, true);
    if (!src) { setTimeout(() => { if (this._ambience) this.startRain(); }, 200); return; }
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5200;
    const g = this.ctx.createGain();

    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.master);
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.8);   // 淡入，无爆音

    // 缓慢起伏（LFO 也做 ramp 起步）
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoG = this.ctx.createGain();
    lfoG.gain.setValueAtTime(0.0001, t);
    lfoG.gain.exponentialRampToValueAtTime(0.018, t + 1.2);
    lfo.connect(lfoG); lfoG.connect(g.gain);
    lfo.start(t);

    this.live.add(src); this.live.add(hp); this.live.add(lp); this.live.add(g);
    this.live.add(lfo); this.live.add(lfoG);
    src.start(t);   // 循环音源，不 stop
    this.rainNodes = { src, g, hp, lp, lfo, lfoG };
  }

  /* ============================================================
     枪声
     ============================================================ */
  gunshot(id, distant = false) {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    const t = this.ctx.currentTime;
    const heavy = id === 'vk12' || id === 'r7';
    const quiet = id === 'p9' || id === 'k9';
    const gainScale = distant ? 0.45 : 1;

    // 爆响
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

    // 低频体感
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(heavy ? 120 : 165, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.13);
    const og = this.ctx.createGain();
    this._env(og.gain, t, (heavy ? 0.26 : 0.15) * gainScale, 5, 140);
    osc.connect(og); og.connect(this.master);
    this._v(osc, [og]);
    osc.start(t); osc.stop(t + 0.3);

    // 尾音
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
     6. 闪光弹：整体音量压低，耳鸣音不刺耳
     ============================================================ */
  flashbang() {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    if (!this._gate('flash', 150)) return;      // 连续引爆时不叠加成啸叫
    const t = this.ctx.currentTime;

    // 冲击波
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

    // 低频体感
    const boom = this.ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(130, t);
    boom.frequency.exponentialRampToValueAtTime(42, t + 0.34);
    const bg = this.ctx.createGain();
    this._env(bg.gain, t, 0.3, 6, 340);
    boom.connect(bg); bg.connect(this.master);
    this._v(boom, [bg]);
    boom.start(t); boom.stop(t + 0.5);

    // 耳鸣：频率降到 2.2kHz 并加低通柔化，音量压到 0.028，快速衰减
    const ring = this.ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.setValueAtTime(2200, t + 0.02);
    ring.frequency.exponentialRampToValueAtTime(1750, t + 1.6);
    const ringLp = this.ctx.createBiquadFilter();
    ringLp.type = 'lowpass'; ringLp.frequency.value = 3000; ringLp.Q.value = 0.6;
    const rg = this.ctx.createGain();
    this._env(rg.gain, t + 0.02, 0.028, 20, 1500);   // 20ms 淡入，避免起音爆点
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

  thunder() {
    if (!this.ready || this.muted || !this.noiseReady) return;
    if (!this._budget()) return;
    if (!this._gate('thunder', 800)) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource(0.25);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 260;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.22, 60, 2400);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    this._v(src, [lp, g]);
    src.start(t); src.stop(t + 3.2);
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
     诊断：给压力测试与调试面板用
     ============================================================ */
  stats() {
    return {
      ctxCount: CTX_CREATED,          // 必须恒为 1
      ctxState: this.ctx ? this.ctx.state : 'none',
      liveNodes: this.live.size,
      noiseReady: this.noiseReady,
      gated: this._gatedCount,
      dropped: this._droppedCount,
      voices: this.live.size,
    };
  }
}
