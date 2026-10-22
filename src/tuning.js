/* ============================================================
   tuning.js - live tuning panel
   ------------------------------------------------------------
   P       : open/close the full panel (releases the pointer, keeps time at 100%, WASD still moves)
   O       : read-only overlay (does not release the pointer; shows four curves and values)
   [ / ]   : in overlay mode, decrease / increase the selected parameter
   , / .   : in overlay mode, cycle the selected parameter
   Dragging a slider or editing a number box writes straight to feel.js and takes effect next frame.
   ============================================================ */
import {
  feel, FEEL_SCHEMA, FEEL_PRESETS, PRESET_LABELS,
  snapshotFeel, applyFeel, exportFeelJSON, telemetry,
} from './feel.js';

const flat = [];
for (const g of FEEL_SCHEMA) {
  for (const it of g.items) {
    flat.push({ group: g.group, key: it[0], label: it[1], min: it[2], max: it[3], step: it[4], unit: it[5] || '', wired: it[6] !== false, type: it[7] || 'num' });
  }
}

export class TuningPanel {
  constructor(game) {
    this.game = game;
    this.open = false;
    this.overlay = false;
    FEEL_PRESETS.A = snapshotFeel();          // slot A is fixed to "Original (pre-change)"
    this._build();
    this._lastDraw = 0;
  }

  /* ---------------- DOM ---------------- */
  _build() {
    const p = document.createElement('div');
    p.id = 'tuning-panel';
    p.className = 'hidden';
    p.innerHTML = [
      '<div class="tp-head"><b>FEEL TUNING</b>',
      '<span class="tp-hint">P close · O overlay · values apply instantly</span>',
      '<button type="button" data-tp="close">×</button></div>',
      '<div class="tp-bar">',
      '<button type="button" data-tp="preset-save" data-slot="A">Save to A</button>',
      '<button type="button" data-tp="preset-load" data-slot="A">Load A (original)</button>',
      '<button type="button" data-tp="preset-save" data-slot="B">Save to B</button>',
      '<button type="button" data-tp="preset-load" data-slot="B">Load B</button>',
      '<button type="button" data-tp="preset-save" data-slot="C">Save to C</button>',
      '<button type="button" data-tp="preset-load" data-slot="C">Load C</button>',
      '<span class="tp-sep"></span>',
      '<button type="button" data-tp="export">Export JSON</button>',
      '<button type="button" data-tp="copy">Copy to clipboard</button>',
      '<span class="tp-sep"></span>',
      '<label class="tp-chk"><input type="checkbox" data-tp="freezeAI"> Freeze enemy AI</label>',
      '<label class="tp-chk"><input type="checkbox" data-tp="invincible"> Invincible</label>',
      '<label class="tp-chk"><input type="checkbox" data-tp="headBob" checked> Head bob</label>',
      '<span class="tp-sep"></span>',
      '<button type="button" data-tp="reset-curves">Reset curves</button>',
      '</div>',
      '<div class="tp-body"><div class="tp-groups"></div>',
      '<div class="tp-right"><canvas id="tp-curves" width="300" height="260"></canvas>',
      '<div id="tp-readout" class="tp-readout"></div></div></div>',
      '<textarea class="tp-text" id="tp-text" readonly spellcheck="false"></textarea>',
    ].join('');
    document.body.appendChild(p);
    this.el = p;
    this.groups = p.querySelector('.tp-groups');
    this.curves = p.querySelector('#tp-curves');
    this.readout = p.querySelector('#tp-readout');
    this.textBox = p.querySelector('#tp-text');
    this._buildSliders();
    p.addEventListener('click', (e) => this._onClick(e));
    p.addEventListener('change', (e) => this._onChange(e));
    /* Don't let WASD reach the game while an input has focus */
    p.addEventListener('keydown', (e) => e.stopPropagation(), true);

    const o = document.createElement('div');
    o.id = 'tuning-overlay';
    o.className = 'hidden';
    o.innerHTML = '<canvas id="tp-mini" width="260" height="200"></canvas><div id="tp-mini-read"></div>' +
      '<div class="tp-mini-foot">O close · [ ] adjust · , . cycle</div>';
    document.body.appendChild(o);
    this.oel = o;
    this.mini = o.querySelector('#tp-mini');
    this.miniRead = o.querySelector('#tp-mini-read');
  }

  _buildSliders() {
    for (const g of FEEL_SCHEMA) {
      const sec = document.createElement('div');
      sec.className = 'tp-group';
      sec.innerHTML = '<h4>' + g.label + '</h4>';
      for (const it of g.items) {
        const meta = flat.find((f) => f.group === g.group && f.key === it[0]);
        const row = document.createElement('div');
        row.className = 'tp-row' + (meta.wired ? '' : ' unwired');
        const id = 'tp-' + g.group + '-' + it[0];
        row.innerHTML = '<label for="' + id + '">' + it[1] +
          (meta.wired ? '' : '<i class="badge">NOT WIRED</i>') +
          '<em>' + (it[5] || '') + '</em></label>' +
          (meta.type === 'bool'
            ? '<input type="checkbox" id="' + id + '" data-g="' + g.group + '" data-k="' + it[0] + '">'
            : '<input type="range" id="' + id + '" data-g="' + g.group + '" data-k="' + it[0] + '" min="' + it[2] + '" max="' + it[3] + '" step="' + it[4] + '">' +
              '<input type="number" class="num" data-g="' + g.group + '" data-k="' + it[0] + '" min="' + it[2] + '" max="' + it[3] + '" step="' + it[4] + '">');
        sec.appendChild(row);
      }
      this.groups.appendChild(sec);
    }
    this.syncFromFeel();
  }

  /* Push current feel values into the controls */
  syncFromFeel() {
    this.el.querySelectorAll('[data-g]').forEach((inp) => {
      const v = feel[inp.dataset.g][inp.dataset.k];
      if (inp.type === 'checkbox') inp.checked = !!v;
      else inp.value = v;
    });
  }

  _onChange(e) {
    const t = e.target;
    if (!t.dataset || !t.dataset.g) return;
    const v = t.type === 'checkbox' ? t.checked : parseFloat(t.value);
    if (t.type !== 'checkbox' && !Number.isFinite(v)) return;
    feel[t.dataset.g][t.dataset.k] = v;
    /* Sync the other control for the same parameter (slider <-> number box) */
    this.el.querySelectorAll('[data-g="' + t.dataset.g + '"][data-k="' + t.dataset.k + '"]').forEach((other) => {
      if (other === t || other.type === 'checkbox') return;
      other.value = v;
    });
  }

  _onClick(e) {
    const b = e.target.closest ? e.target.closest('[data-tp]') : null;
    if (!b) return;
    const a = b.dataset.tp;
    if (a === 'close') this.hide();
    else if (a === 'preset-save') { FEEL_PRESETS[b.dataset.slot] = snapshotFeel(); this._flash(b, 'Saved'); }
    else if (a === 'preset-load') {
      const snap = FEEL_PRESETS[b.dataset.slot];
      if (!snap) { this._flash(b, 'Empty slot'); return; }
      applyFeel(snap); this.syncFromFeel(); this._flash(b, 'Loaded');
    } else if (a === 'export') { this.textBox.value = exportFeelJSON(); this.textBox.classList.toggle('open'); }
    else if (a === 'copy') this._copy();
    else if (a === 'reset-curves') { telemetry.reset(); this._flash(b, 'Reset'); }
  }

  _flash(btn, msg) {
    const old = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = old; }, 900);
  }

  _copy() {
    const json = exportFeelJSON();
    this.textBox.value = json;
    this.textBox.classList.add('open');
    const done = () => this._flash(this.el.querySelector('[data-tp="copy"]'), 'Copied');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(done).catch(() => this._selectCopy());
    } else this._selectCopy();
  }
  _selectCopy() {
    this.textBox.select();
    try { document.execCommand('copy'); } catch (err) { /* manual copy */ }
    this._flash(this.el.querySelector('[data-tp="copy"]'), 'Copy manually');
  }

  /* ---------------- Show/hide ---------------- */
  show() {
    this.open = true;
    this.syncFromFeel();
    this.el.classList.remove('hidden');
    if (document.exitPointerLock) document.exitPointerLock();
  }
  hide() {
    this.open = false;
    this.el.classList.add('hidden');
    if (this.game && this.game.state === 'play') this.game.requestLock();
  }
  toggle() { this.open ? this.hide() : this.show(); }

  showOverlay() { this.overlay = true; this.oel.classList.remove('hidden'); this.syncFromFeel(); }
  hideOverlay() { this.overlay = false; this.oel.classList.add('hidden'); }
  toggleOverlay() { this.overlay ? this.hideOverlay() : this.showOverlay(); }

  /* ---------------- Overlay mode: keyboard adjustment ---------------- */
  _idx() {
    let i = flat.findIndex((f) => f.group + '.' + f.key === feel.debug.selectedParam);
    return i < 0 ? 0 : i;
  }
  cycle(dir) {
    const i = (this._idx() + dir + flat.length) % flat.length;
    const f = flat[i];
    feel.debug.selectedParam = f.group + '.' + f.key;
  }
  adjust(dir) {
    const f = flat[this._idx()];
    if (!f) return;
    if (f.type === 'bool') { feel[f.group][f.key] = !feel[f.group][f.key]; return; }
    const step = f.step || 0.01;
    const raw = feel[f.group][f.key] + dir * step * (f.max - f.min > 20 ? 5 : 1);
    feel[f.group][f.key] = Math.min(f.max, Math.max(f.min, +raw.toFixed(6)));
    if (this.open) this.syncFromFeel();
  }

  /* ---------------- Per frame: draw four curves ---------------- */
  update(dt) {
    if (!this.open && !this.overlay) return;
    this._lastDraw += dt;
    if (this._lastDraw < 1 / 30) return;
    this._lastDraw = 0;
    this._draw(this.curves, 300, 260, false);
    this._draw(this.mini, 260, 200, true);
  }

  _draw(cv, w, h, mini) {
    if (!cv) return;
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(6,12,17,.92)';
    c.fillRect(0, 0, w, h);
    const plots = [
      { key: 'speed',  label: 'Speed m/s',  color: '#54d6c6', max: Math.max(1, telemetry.max.speed) },
      { key: 'accel',  label: 'Accel m/s²', color: '#ffd447', max: Math.max(1, telemetry.max.accel) },
      { key: 'recoil', label: 'Recoil rad',   color: '#ff9a3c', max: Math.max(0.05, telemetry.max.recoil) },
      { key: 'spread', label: 'Spread rad',   color: '#74b6ff', max: Math.max(0.01, telemetry.max.spread) },
    ];
    const ph = (h - 10) / 4;
    for (let pi = 0; pi < 4; pi++) {
      const p = plots[pi];
      const top = 6 + pi * ph;
      const base = top + ph - 12;
      c.strokeStyle = 'rgba(150,190,210,.18)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(6, base + 0.5); c.lineTo(w - 6, base + 0.5); c.stroke();
      c.fillStyle = 'rgba(200,225,238,.62)';
      c.font = '10px ui-monospace, monospace';
      c.fillText(p.label, 8, top + 9);
      const arr = telemetry[p.key];
      const n = Math.min(telemetry.count, telemetry.N);
      c.strokeStyle = p.color;
      c.lineWidth = 1.4;
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const idx = (telemetry.i - n + i + telemetry.N * 2) % telemetry.N;
        const v = arr[idx];
        const x = 6 + (i / (telemetry.N - 1)) * (w - 12);
        const y = base - Math.min(1, Math.abs(v) / p.max) * (ph - 16);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.fillStyle = p.color;
      c.fillText(telemetry.cur[p.key].toFixed(3), w - 62, top + 9);
    }
    if (this.overlay) this.miniRead.textContent = this.readoutText();
  }

  /* Value text in overlay mode */
  readoutText() {
    const f = flat[this._idx()];
    if (!f) return '';
    const v = feel[f.group][f.key];
    return f.group + '.' + f.key + ' = ' + (typeof v === 'number' ? v.toFixed(4) : String(v)) + ' ' + f.unit;
  }
}
