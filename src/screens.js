/* ============================================================
   screens.js — 主菜单 / 简报 / 装备配置 / 战果面板 / 暂停
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
       全部按钮只在 #app 容器上委托一次：
       不依赖 DOMContentLoaded 时机，也不依赖脚本执行顺序，
       动态生成的按钮（如装备选项）同样自动生效。
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
        console.error('[SILENT MERIDIAN] 动作执行失败：' + el.dataset.action, err);
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

  /* ---------------- 装备配置 ---------------- */
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
      ['火力', Math.round(fire)], ['精度', Math.round(acc)],
      ['机动', Math.round(mob)], ['防护', Math.round(prot)],
      ['观察', Math.round(clamp(obsBase * (p.id === 'k9' ? 1.06 : 1) * (a.id === 'light' ? 1.08 : 1), 0, 100))],
    ];
    $('#stat-bars').innerHTML = rows.map(([k, v]) =>
      `<div class="bar-row"><span>${k}</span><div class="track"><i style="width:${v}%"></i></div><b>${v}</b></div>`).join('');
  }

  /* ---------------- 战果 ---------------- */
  showDebrief(res) {
    const t = $('#debrief-title');
    t.textContent = res.success ? '行动完成 — 港区已控制' : '行动中止 — 目标未达成';
    const gs = $('#grade-stamp');
    gs.className = res.grade === 'S' ? 'doc-stamp s' : 'doc-stamp';
    gs.innerHTML = `评级<br><b>${res.grade}</b>`;

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
      ['用时', res.time, ''],
      ['射击发数', res.shots, ''],
      ['命中率', res.accuracy + '%', res.accuracy >= 35 ? 'good' : res.accuracy >= 18 ? 'warn' : 'bad'],
      ['盲射（未识别即开火）', res.blindShots, res.blindShots <= 2 ? 'good' : res.blindShots <= 6 ? 'warn' : 'bad'],
      ['嫌疑人拘押', `${res.detained} / ${res.suspectTotal}`, res.detained > 0 ? 'good' : ''],
      ['嫌疑人击毙', res.killed, res.killed === 0 ? 'good' : ''],
      ['嫌疑人脱逃', res.escaped, res.escaped === 0 ? 'good' : 'warn'],
      ['平民安全撤离', `${res.civSafe} / ${res.civTotal}`, res.civSafe === res.civTotal ? 'good' : 'warn'],
      ['平民伤亡', res.civLost, res.civLost === 0 ? 'good' : 'bad'],
      ['指令次数', res.orders, ''],
      ['队员伤亡', res.squadDown, res.squadDown === 0 ? 'good' : 'bad'],
      ['投掷器材', res.gadgets, ''],
    ];
    sg.innerHTML = rows.map(([k, v, c]) =>
      `<div class="st-cell"><span>${k}</span><b class="${c}">${v}</b></div>`).join('');

    const sr = $('#debrief-squad');
    sr.innerHTML = '';
    for (const m of res.squad) {
      const d = document.createElement('div');
      d.className = 'rr ' + (m.alive ? (m.hp > m.maxHp * 0.6 ? 'ok' : 'hurt') : 'down');
      d.innerHTML = `<div class="rn"><b>${m.callsign}</b><span>${m.role || ''}</span></div>
        <div class="rs">${m.alive ? `在岗 ${Math.round(m.hp)}/${m.maxHp}` : '失去行动能力'}</div>`;
      sr.appendChild(d);
    }

    $('#debrief-comment').innerHTML = `<div class="ct">事后评述 / AFTER-ACTION</div><p>${res.comment}</p>`;
  }

  /* ---------------- 屏幕切换 ---------------- */
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
  if (id === 'manifest') return st === 'done' ? '货运货单已取回并封存' : '货单未取回';
  if (id === 'evidence') return st === 'done' ? '调度室监控与登记记录已提取' : '调度室证据未获取';
  if (id === 'civilians') return st === 'done' ? `${res.civSafe} 名夜班工人安全撤离` : `仅 ${res.civSafe} 人撤离`;
  if (id === 'suspects') return `拘押 ${res.detained} · 击毙 ${res.killed} · 脱逃 ${res.escaped}`;
  if (id === 'extract') return st === 'done' ? '小队已撤出港区' : '小队未完成撤离';
  return '';
}
