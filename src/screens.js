/* ============================================================
   screens.js — main menu / briefing / loadout / debrief / pause
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
    this.wireTitleKeys();
  }

  /* Title menu: ↑/↓ (or W/S) move between items, Enter/Space activate (native button behaviour), Home/End jump. */
  wireTitleKeys() {
    document.addEventListener('keydown', (e) => {
      if (this.current !== 'title') return;
      const items = [...document.querySelectorAll('#screen-title .tm-item')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      let next = -1;
      if (e.code === 'ArrowDown' || e.code === 'KeyS') next = i < 0 ? 0 : (i + 1) % items.length;
      else if (e.code === 'ArrowUp' || e.code === 'KeyW') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
      else if (e.code === 'Home') next = 0;
      else if (e.code === 'End') next = items.length - 1;
      if (next < 0) return;
      e.preventDefault();
      items[next].focus();
    });
  }

  /* operation card: last recorded result in this browser, if any */
  refreshTitleCard() {
    const el = $('#op-last');
    if (!el) return;
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem('sm.lastOperation') || 'null'); } catch (e) { rec = null; }
    if (!rec || !rec.grade) { el.textContent = 'No operation on record'; return; }
    const ago = Math.max(0, Date.now() - (rec.at || 0));
    const h = Math.floor(ago / 3600000), d = Math.floor(h / 24);
    const when = d >= 1 ? `${d} d ago` : h >= 1 ? `${h} h ago` : 'just now';
    el.textContent = `Last: grade ${rec.grade} · ${rec.time} · ${rec.success ? 'complete' : 'aborted'} · ${when}`;
  }

  wire() {
    /* ------------------------------------------------------------
       All buttons are delegated once on the #app container:
       independent of DOMContentLoaded timing and script order,
       and dynamically generated buttons (e.g. loadout picks) work automatically.
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
        console.error('[SILENT MERIDIAN] action failed: ' + el.dataset.action, err);
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
      ['Firepower', Math.round(fire)], ['Accuracy', Math.round(acc)],
      ['Mobility', Math.round(mob)], ['Protection', Math.round(prot)],
      ['Observation', Math.round(clamp(obsBase * (p.id === 'k9' ? 1.06 : 1) * (a.id === 'light' ? 1.08 : 1), 0, 100))],
    ];
    $('#stat-bars').innerHTML = rows.map(([k, v]) =>
      `<div class="bar-row"><span>${k}</span><div class="track"><i style="width:${v}%"></i></div><b>${v}</b></div>`).join('');
  }

  /* ---------------- Debrief ---------------- */
  showDebrief(res) {
    const t = $('#debrief-title');
    t.textContent = res.success ? 'Operation complete — port secured' : 'Operation aborted — objectives not met';
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
      ['Rounds fired', res.shots, ''],
      ['Hit rate', res.accuracy + '%', res.accuracy >= 35 ? 'good' : res.accuracy >= 18 ? 'warn' : 'bad'],
      ['Blind shots (fired before ID)', res.blindShots, res.blindShots <= 2 ? 'good' : res.blindShots <= 6 ? 'warn' : 'bad'],
      ['Suspects detained', `${res.detained} / ${res.suspectTotal}`, res.detained > 0 ? 'good' : ''],
      ['Suspects killed', res.killed, res.killed === 0 ? 'good' : ''],
      ['Suspects escaped', res.escaped, res.escaped === 0 ? 'good' : 'warn'],
      ['Civilians evacuated', `${res.civSafe} / ${res.civTotal}`, res.civSafe === res.civTotal ? 'good' : 'warn'],
      ['Civilian casualties', res.civLost, res.civLost === 0 ? 'good' : 'bad'],
      ['Orders given', res.orders, ''],
      ['Squad casualties', res.squadDown, res.squadDown === 0 ? 'good' : 'bad'],
      ['Gadgets used', res.gadgets, ''],
    ];
    sg.innerHTML = rows.map(([k, v, c]) =>
      `<div class="st-cell"><span>${k}</span><b class="${c}">${v}</b></div>`).join('');

    const sr = $('#debrief-squad');
    sr.innerHTML = '';
    for (const m of res.squad) {
      const d = document.createElement('div');
      d.className = 'rr ' + (m.alive ? (m.hp > m.maxHp * 0.6 ? 'ok' : 'hurt') : 'down');
      d.innerHTML = `<div class="rn"><b>${m.callsign}</b><span>${m.role || ''}</span></div>
        <div class="rs">${m.alive ? `On duty ${Math.round(m.hp)}/${m.maxHp}` : 'Down'}</div>`;
      sr.appendChild(d);
    }

    $('#debrief-comment').innerHTML = `<div class="ct">After-action note</div><p>${res.comment}</p>`;
  }

  /* ---------------- Screen switching ---------------- */
  hideAll() {
    ['title', 'briefing', 'loadout', 'debrief', 'help', 'pause'].forEach((s) => {
      const el = $('#screen-' + s);
      if (el) el.classList.add('hidden');
    });
  }

  show(name) {
    /* leaving a debrief for the title tears the mission down and brings the live port back */
    if (name === 'title' && this.game.state === 'debrief') this.game.abort();
    if (name === 'title') this.refreshTitleCard();
    this.hideAll();
    const el = $('#screen-' + name);
    if (el) el.classList.remove('hidden');
    this.current = name;
    if (name === 'loadout') this.refreshStats();
    document.body.style.cursor = name === 'game' ? 'none' : 'default';
    /* Keyboard accessibility: move focus into the new screen after a switch.
       Previously .hidden{display:none} removed the focused element from the render tree,
       focus silently fell back to <body> and Tab order restarted at the top — keyboard users lost their place. */
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
  if (id === 'manifest') return st === 'done' ? 'Manifest recovered and sealed' : 'Manifest not recovered';
  if (id === 'evidence') return st === 'done' ? 'Dispatch CCTV and gate log secured' : 'Dispatch evidence not secured';
  if (id === 'civilians') return st === 'done' ? `${res.civSafe} night crew evacuated` : `Only ${res.civSafe} evacuated`;
  if (id === 'suspects') return `Detained ${res.detained} · killed ${res.killed} · escaped ${res.escaped}`;
  if (id === 'extract') return st === 'done' ? 'Squad clear of the port' : 'Squad did not exfil';
  return '';
}
