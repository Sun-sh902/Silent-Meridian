/* ============================================================
   screens.js — main menu / briefing / loadout / debrief panel / pause
   ============================================================ */
import { WEAPONS, GADGETS, ARMORS, DEFAULT_LOADOUT, SQUAD_ROSTER, OBJECTIVES } from './data.js';
import { clamp } from './geom.js';

const $ = (s) => document.querySelector(s);

export class Screens {
  constructor(game) {
    this.game = game;
    this.current = 'title';
    this.loadout = { ...DEFAULT_LOADOUT };
    this.buildLoadout();
    this.wire();
  }

  wire() {
    /* ------------------------------------------------------------
       All buttons are delegated once on the #app container:
       no dependency on DOMContentLoaded timing or script execution order,
       and dynamically generated buttons (such as loadout options) work automatically too.
       ------------------------------------------------------------ */
    this.actions = {
      'screen':     (el) => this.show(el.dataset.screen),
      'help-open':  () => { this.prev = this.current; this.show('help'); },
      'help-close': () => this.show(this.prev || 'title'),
      'deploy':     () => this.game.deploy(this.loadout),
      'retry':      () => this.game.deploy(this.loadout),
      'restart':    () => { this.hideAll(); this.game.deploy(this.loadout); },
      'resume':     () => this.game.togglePause(false),
      'abort':      () => { this.hideAll(); this.game.abort(); this.show('title'); },
      'order':      (el) => this.game.issueOrder(el.dataset.order),
      'pick':       (el) => this.selectLoadout(el.dataset.slot, el.dataset.id),
    };
    const container = () => document.getElementById('app') || document.body;
    container().addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
      if (!el) return;
      const fn = this.actions[el.dataset.action];
      if (!fn) return;
      e.preventDefault();
      try {
        fn(el);
      } catch (err) {
        console.error('[SILENT MERIDIAN] Action failed: ' + el.dataset.action, err);
      }
    });
    if (window.__SM_DEBUG) {
      window.__SM_DEBUG.handlerReady = true;
      window.__SM_DEBUG.actions = Object.keys(this.actions);
    }
  }

  selectLoadout(slot, id) {
    if (!(slot in this.loadout)) return;
    this.loadout[slot] = id;
    document.querySelectorAll(`.pick[data-slot="${slot}"]`).forEach((p) => {
      p.classList.toggle('sel', p.dataset.id === id);
    });
    this.refreshStats();
    this.game.audio.init();
    this.game.audio.click(0.18, 1200);
  }

  /* ---------------- Loadout ---------------- */
  buildLoadout() {
    const mk = (container, items, key, fmt) => {
      container.innerHTML = '';
      items.forEach((id) => {
        const it = fmt(id);
        const b = document.createElement('button');
        b.className = 'pick' + (this.loadout[key] === id ? ' sel' : '');
        b.dataset.id = id;
        b.dataset.slot = key;
        b.dataset.action = 'pick';
        b.innerHTML = `<div class="pn"><b>${it.name}</b><i>${it.brand || it.short || ''}</i></div>
          <div class="pd">${it.desc}</div>
          ${it.stats ? `<div class="stats">${Object.entries(it.stats).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')}</div>` : ''}`;
        container.appendChild(b);
      });
    };
    mk($('#primary-list'), ['mr4', 'vk12', 'k9'], 'primary', (id) => WEAPONS[id]);
    mk($('#sidearm-list'), ['p9', 'r7'], 'sidearm', (id) => WEAPONS[id]);
    mk($('#gadget-list'), ['flash', 'smoke', 'breach', 'trauma'], 'gadget', (id) => GADGETS[id]);
    mk($('#armor-list'), ['light', 'standard', 'heavy'], 'armor', (id) => ARMORS[id]);

    const roster = $('#squad-roster');
    roster.innerHTML = '';
    SQUAD_ROSTER.forEach((o) => {
      const d = document.createElement('div');
      d.className = 'op' + (o.lead ? ' lead' : '');
      d.innerHTML = `<div class="av">${o.id}</div>
        <div class="oi"><b>${o.name}</b><span>${o.role}${o.callsign ? ' · ' + o.callsign : ''}</span></div>`;
      roster.appendChild(d);
    });
    this.refreshStats();
  }

  refreshStats() {
    const p = WEAPONS[this.loadout.primary];
    const a = ARMORS[this.loadout.armor];
    const g = GADGETS[this.loadout.gadget];
    const perShot = p.damage * (p.pellets || 1);
    const dps = perShot * p.rpm / 60;
    const fire = clamp(dps / 4 + (perShot - 20) * 0.35, 8, 100);
    const acc = clamp(100 - (p.spread * 1400 + p.adsSpread * 1800), 18, 100);
    const mob = clamp(a.speed * 78, 20, 100);
    const prot = clamp(a.hp / 1.7, 20, 100);
    const obsBase = g.id === 'smoke' ? 88 : g.id === 'flash' ? 82 : 74;
    const rows = [
      ['FIREPOWER', Math.round(fire)], ['ACCURACY', Math.round(acc)],
      ['MOBILITY', Math.round(mob)], ['PROTECTION', Math.round(prot)],
      ['OBSERVATION', Math.round(clamp(obsBase * (p.id === 'k9' ? 1.06 : 1) * (a.id === 'light' ? 1.08 : 1), 0, 100))],
    ];
    $('#stat-bars').innerHTML = rows.map(([k, v]) =>
      `<div class="bar-row"><span>${k}</span><div class="track"><i style="width:${v}%"></i></div><b>${v}</b></div>`).join('');
  }

  /* ---------------- Debrief ---------------- */
  showDebrief(res) {
    const t = $('#debrief-title');
    t.textContent = res.success ? 'Operation Complete — Port Secure' : 'Operation Aborted — Objectives Not Met';
    const gs = $('#grade-stamp');
    gs.className = res.grade === 'S' ? 'doc-stamp s' : 'doc-stamp';
    gs.innerHTML = `GRADE<br><b>${res.grade}</b>`;

    const ol = $('#debrief-objectives');
    ol.innerHTML = '';
    for (const o of OBJECTIVES) {
      const st = res.objectives[o.id];
      const li = document.createElement('li');
      li.className = st === 'done' ? 'ok' : st === 'failed' ? 'no' : '';
      li.innerHTML = `<div><b>${o.label}</b><span>${objectiveNote(o.id, st, res)}</span></div>`;
      ol.appendChild(li);
    }

    const sg = $('#debrief-stats');
    const rows = [
      ['Time', res.time, ''],
      ['Shots fired', res.shots, ''],
      ['Accuracy', res.accuracy + '%', res.accuracy >= 35 ? 'good' : res.accuracy >= 18 ? 'warn' : 'bad'],
      ['Blind shots (fired before identification)', res.blindShots, res.blindShots <= 2 ? 'good' : res.blindShots <= 6 ? 'warn' : 'bad'],
      ['Suspects detained', `${res.detained} / ${res.suspectTotal}`, res.detained > 0 ? 'good' : ''],
      ['Suspects killed', res.killed, res.killed === 0 ? 'good' : ''],
      ['Suspects escaped', res.escaped, res.escaped === 0 ? 'good' : 'warn'],
      ['Civilians safely evacuated', `${res.civSafe} / ${res.civTotal}`, res.civSafe === res.civTotal ? 'good' : 'warn'],
      ['Civilian casualties', res.civLost, res.civLost === 0 ? 'good' : 'bad'],
      ['Orders issued', res.orders, ''],
      ['Squad casualties', res.squadDown, res.squadDown === 0 ? 'good' : 'bad'],
      ['Gadgets thrown', res.gadgets, ''],
    ];
    sg.innerHTML = rows.map(([k, v, c]) =>
      `<div class="st-cell"><span>${k}</span><b class="${c}">${v}</b></div>`).join('');

    const sr = $('#debrief-squad');
    sr.innerHTML = '';
    for (const m of res.squad) {
      const d = document.createElement('div');
      d.className = 'rr ' + (m.alive ? (m.hp > m.maxHp * 0.6 ? 'ok' : 'hurt') : 'down');
      d.innerHTML = `<div class="rn"><b>${m.callsign}</b><span>${m.role || ''}</span></div>
        <div class="rs">${m.alive ? `ACTIVE ${Math.round(m.hp)}/${m.maxHp}` : 'INCAPACITATED'}</div>`;
      sr.appendChild(d);
    }

    $('#debrief-comment').innerHTML = `<div class="ct">AFTER-ACTION COMMENT</div><p>${res.comment}</p>`;
  }

  /* ---------------- Screen switching ---------------- */
  hideAll() {
    ['title', 'briefing', 'loadout', 'debrief', 'help', 'pause'].forEach((s) => {
      const el = $('#screen-' + s);
      if (el) el.classList.add('hidden');
    });
  }

  show(name) {
    this.hideAll();
    const el = $('#screen-' + name);
    if (el) el.classList.remove('hidden');
    this.current = name;
    if (name === 'loadout') this.refreshStats();
    document.body.style.cursor = name === 'game' ? 'none' : 'default';
    /* Keyboard accessibility: move focus into the new screen after a switch.
       Previously .hidden{display:none} removed the focused element from the render tree entirely,
       so focus silently fell back to <body>, Tab order restarted at the top of the document, and keyboard users lost their place. */
    if (el && name !== 'game') {
      const first = el.querySelector('button:not([disabled]), [href], input, select, textarea');
      if (first) first.focus({ preventScroll: true });
    }
  }

  showGame() {
    this.hideAll();
    this.current = 'game';
    $('#hud').classList.remove('hidden');
  }

  hideGame() {
    $('#hud').classList.add('hidden');
  }
}

function objectiveNote(id, st, res) {
  if (id === 'manifest') return st === 'done' ? 'Cargo manifest recovered and sealed' : 'Manifest not recovered';
  if (id === 'evidence') return st === 'done' ? 'Dispatch surveillance and registration records extracted' : 'Dispatch evidence not obtained';
  if (id === 'civilians') return st === 'done' ? `${res.civSafe} night-shift workers safely evacuated` : `Only ${res.civSafe} evacuated`;
  if (id === 'suspects') return `Detained ${res.detained} · Killed ${res.killed} · Escaped ${res.escaped}`;
  if (id === 'extract') return st === 'done' ? 'Squad has extracted from the port' : 'Squad did not complete extraction';
  return '';
}
