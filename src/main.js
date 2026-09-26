/* ============================================================
   main.js — 引导
   ============================================================ */
import { Game } from './game.js';
import { DEFAULT_LOADOUT } from './data.js';

const canvas = document.querySelector('#view');

// 通知调试面板：主脚本已成功执行（用于区分“脚本没跑”与“脚本跑了但功能异常”）
if (window.__SM_DEBUG) window.__SM_DEBUG.mainLoaded = true;

function fail(msg) {
  const el = document.querySelector('#boot-error');
  const t = document.querySelector('#boot-error-text');
  if (t) t.textContent = msg;
  if (el) el.classList.remove('hidden');
  console.error('[SILENT MERIDIAN]', msg);
}

window.addEventListener('error', (e) => {
  const msg = '运行期异常：' + (e.message || e.error || 'unknown');
  // 仅在尚未进入行动时用全屏提示；游戏中的偶发异常只记录日志，避免打断游玩
  if (!window.__game || window.__game.state === 'menu') fail(msg);
  else console.error('[SILENT MERIDIAN]', msg);
});

try {
  const game = new Game(canvas);
  window.__game = game;

  // QA / 调试参数
  const params = new URLSearchParams(location.search);
  if (params.has('deploy')) {
    game.deploy({ ...DEFAULT_LOADOUT });
    if (params.has('yaw')) game.player.yaw = parseFloat(params.get('yaw'));
    if (params.has('pos')) {
      const [x, z] = params.get('pos').split(',').map(Number);
      game.player.pos.x = x; game.player.pos.z = z;
      game.player.y = 0;
    }
    if (params.has('freeze')) game.paused = true;
    /* 测试模式：由外部以固定步长驱动 advance()，用于可复现的回归基线 */
    if (params.has('test')) game.testMode = true;
    if (params.has('novm') && game.viewmodel) game.viewmodel.root.visible = false;
    if (params.has('nolight')) game.lightOn = false;
    if (params.has('tacmap')) game.toggleTacMap();
    if (params.has('tacmaponly')) { game.toggleTacMap(); game.tacmap.buildStatic(); game.tacmap.render(); }
    if (params.has('alarm')) {
      setTimeout(() => {
        game.raiseAlarm('QA');
        for (const s of game.suspects) {
          s.awareness = 1; s.alerted = true; s.state = 'engage'; s.target = game.player;
        }
      }, 800);
    }
    if (params.has('fire')) {
      setTimeout(() => { game.player.fireOnce(); }, 1500);
    }
    if (params.has('dummy')) {
      // QA: 在正前方放置静止目标，用于检查模型与识别流程
      setTimeout(() => {
        const d = parseFloat(params.get('dummy')) || 8;
        const p = game.player;
        const f = p.forward;
        game.suspects.forEach((s, i) => {
          s.speed = 0; s.patrolRoute = null; s.state = 'post';
          s.pos.x = p.pos.x + f.x * (d + i * 3) + (i === 0 ? 0 : (i % 2 ? 2.4 : -2.4));
          s.pos.z = p.pos.z + f.z * (d + i * 3);
          s.yaw = Math.atan2(-(p.pos.x - s.pos.x), -(p.pos.z - s.pos.z));
          s.targetYaw = s.yaw; s.baseYaw = s.yaw;
        });
        game.civilians.forEach((c, i) => {
          c.pos.x = p.pos.x + f.x * (d + 2) + 3.5 + i * 1.6;
          c.pos.z = p.pos.z + f.z * (d + 2) + 1.5;
        });
      }, 900);
    }
    if (params.has('orders')) {
      const kind = params.get('orders') || 'clear';
      setTimeout(() => {
        const p = game.player, f = p.forward;
        if (kind === 'clear') game.issueClearAt(p.pos.x + f.x * 22, p.pos.z + f.z * 22);
        else game.issueOrder(kind);
      }, 1500);
      if (params.has('then')) {
        setTimeout(() => game.issueOrder(params.get('then')), parseInt(params.get('thenAt') || '12000', 10));
      }
    }
    if (params.has('down')) {
      setTimeout(() => game.player.takeDamage(9999, null), 2000);
    }
  } else if (params.has('screen')) {
    game.screens.show(params.get('screen'));
  }
  if (params.has('debrief')) {
    // QA: 用样例数据检查战果面板版式
    game.screens.showDebrief({
      success: true, grade: 'A', comment: '流程干净、节奏克制。小队的推进与火力纪律都符合警备处的标准作业程序。',
      time: '7:24', shots: 61, accuracy: 38, blindShots: 3, detained: 3, killed: 1, escaped: 0,
      suspectTotal: 9, civSafe: 4, civLost: 0, civTotal: 4, orders: 11, squadDown: 0, gadgets: 2,
      objectives: { manifest: 'done', evidence: 'done', civilians: 'done', suspects: 'done', extract: 'done' },
      squad: [
        { callsign: 'LEAD', role: '制式防弹背心', alive: true, hp: 96, maxHp: 120 },
        { callsign: 'ARDEN-2', role: 'RIFLEMAN · 侦察', alive: true, hp: 118, maxHp: 130 },
        { callsign: 'BRAM-3', role: 'RIFLEMAN · 火力', alive: true, hp: 74, maxHp: 130 },
        { callsign: 'CIRA-4', role: 'BREACHER · 突击', alive: true, hp: 130, maxHp: 130 },
        { callsign: 'DOV-5', role: 'MEDIC · 支援', alive: true, hp: 101, maxHp: 130 },
      ],
    });
    game.screens.show('debrief');
    game.screens.hideGame();
  }
  if (params.has('autotest')) {
    const R = [];
    const log = (k, v) => { R.push(`${k}=${v}`); console.log('[AUTOTEST]', k, v); };
    const at = (ms, fn) => setTimeout(fn, ms);
    at(1200, () => {
      const p = game.player;
      // 1) 货单
      const m = game.objectiveProps.manifest;
      p.pos.x = m.x; p.pos.z = m.z + 1;
      game.actors.forEach((a) => { if (a.kind === 'suspect') { a.pos.x = -60; a.pos.z = -60; } });
      p.doInteract();
      log('manifest', game.objectiveState.manifest);
    });
    at(1900, () => {
      const p = game.player;
      const e = game.objectiveProps.evidence;
      p.pos.x = e.x; p.pos.z = e.z + 1;
      p.doInteract();
      log('evidence', game.objectiveState.evidence);
    });
    at(2600, () => {
      const p = game.player;
      const c = game.civilians[0];
      p.pos.x = c.pos.x + 1; p.pos.z = c.pos.z;
      p.doInteract();
      log('civilian_escort', c.escorted);
      log('extract_before_civs', game.objectiveState.extract);
    });
    at(3400, () => {
      // 直接把其余平民标记为已撤离，检查撤离点激活
      game.civilians.forEach((c) => { if (!c.safe) { c.safe = true; c.escorted = true; game.onCivilianSafe(c); } });
      game.refreshObjectives(); game.checkExtractReady();
      log('civilians', game.objectiveState.civilians);
      log('extract_after_civs', game.objectiveState.extract);
    });
    at(4200, () => {
      // 拘押流程
      const s = game.suspects[0];
      s.pos.x = -30; s.pos.z = 20; s.hp = 30;
      s.surrender();
      const p = game.player;
      p.pos.x = s.pos.x + 1.5; p.pos.z = s.pos.z;
      p.doInteract();
      log('detained', game.counters.detained);
      log('suspect_state', s.state);
    });
    at(5200, () => {
      // 撤离
      const p = game.player;
      game.squad.forEach((s, i) => { s.pos.x = p.pos.x + i; s.pos.z = p.pos.z; });
      const ex = game.world.objectives.extract;
      p.pos.x = ex.x; p.pos.z = ex.z;
      log('extract_zone', 'reached');
    });
    at(6200, () => console.log('[AUTOTEST] RESULTS ' + R.join(' | ')));
  }
} catch (e) {
  fail('初始化失败：' + (e && e.message ? e.message : String(e)));
}
