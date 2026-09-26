/* ============================================================
   geom.js — 数学、空间网格、视线与碰撞
   ============================================================ */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp  = (a, b, t) => a + (b - a) * t;
export const damp  = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const TAU   = Math.PI * 2;

export function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}
export function angleDamp(a, b, lambda, dt) {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * (1 - Math.exp(-lambda * dt));
}
export function shortAngle(a, b) {
  return ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export function dist2D(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}
export function dist3D(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 确定性随机数（用于关卡装饰，保证每次布局一致） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeRng(seed) {
  const r = mulberry32(seed);
  return {
    next: r,
    range: (a, b) => a + r() * (b - a),
    int: (a, b) => Math.floor(a + r() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    sign: () => (r() < 0.5 ? -1 : 1),
  };
}

/* ============================================================
   AABB 碰撞网格
   盒子用 {min:{x,y,z}, max:{x,y,z}, tag, stepOver?} 表示
   ============================================================ */

export class Grid {
  constructor(cell = 8) {
    this.cell = cell;
    this.map = new Map();
    this.boxes = [];
  }
  _key(cx, cz) { return cx * 100003 + cz; }
  add(box) {
    box.id = this.boxes.length;
    this.boxes.push(box);
    const c = this.cell;
    const x0 = Math.floor(box.min.x / c), x1 = Math.floor(box.max.x / c);
    const z0 = Math.floor(box.min.z / c), z1 = Math.floor(box.max.z / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._key(cx, cz);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(box);
      }
    }
    return box;
  }
  /** 查询与给定矩形相交的盒子（去重） */
  queryRect(x0, z0, x1, z1, out) {
    out = out || [];
    out.length = 0;
    const c = this.cell;
    const cx0 = Math.floor(x0 / c), cx1 = Math.floor(x1 / c);
    const cz0 = Math.floor(z0 / c), cz1 = Math.floor(z1 / c);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.map.get(this._key(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const b = arr[i];
          if (out.indexOf(b) === -1) out.push(b);
        }
      }
    }
    return out;
  }
  queryCircle(x, z, r, out) {
    return this.queryRect(x - r, z - r, x + r, z + r, out);
  }
}

/** 视线：从 A 到 B 是否被遮挡（步进采样 + 空间网格） */
export function losBlocked(grid, ax, ay, az, bx, by, bz, ignoreTag) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.05) return false;
  const steps = Math.min(140, Math.max(2, Math.ceil(len / 0.7)));
  const ix = dx / steps, iy = dy / steps, iz = dz / steps;
  let x = ax, y = ay, z = az;
  const scratch = [];
  for (let s = 1; s < steps; s++) {
    x += ix; y += iy; z += iz;
    grid.queryPoint(x, z, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const b = scratch[i];
      if (b.opaque === false) continue;
      if (ignoreTag && b.tag === ignoreTag) continue;
      if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z && y > b.min.y && y < b.max.y) {
        return true;
      }
    }
  }
  return false;
}

Grid.prototype.queryPoint = function (x, z, out) {
  out = out || [];
  out.length = 0;
  const arr = this.map.get(this._key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
  if (!arr) return out;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z) out.push(b);
  }
  return out;
};

/** 圆形角色移动：分轴推进 + 推出 */
const _scratchA = [];
export function moveCircle(grid, pos, radius, dx, dz, feetY, height, canStep = 0.34) {
  const top = feetY + height;
  const resolveAxis = (axis, delta) => {
    if (delta === 0) return;
    pos[axis] += delta;
    const list = grid.queryCircle(pos.x, pos.z, radius + 0.001, _scratchA);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.noCollide) continue;
      if (b.max.y <= feetY + canStep) continue;      // 可跨过的矮物
      if (b.min.y >= top - 0.02) continue;           // 头顶上方
      if (pos.x + radius <= b.min.x || pos.x - radius >= b.max.x) continue;
      if (pos.z + radius <= b.min.z || pos.z - radius >= b.max.z) continue;
      if (axis === 'x') pos.x = delta > 0 ? b.min.x - radius : b.max.x + radius;
      else pos.z = delta > 0 ? b.min.z - radius : b.max.z + radius;
    }
  };
  resolveAxis('x', dx);
  resolveAxis('z', dz);
  return pos;
}

/** 判断某点是否落在任何盒子内（用于出生点检测） */
export function pointFree(grid, x, z, radius, feetY, height) {
  const list = grid.queryCircle(x, z, radius, []);
  const top = feetY + height;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.noCollide) continue;
    if (b.max.y <= feetY + 0.34) continue;
    if (b.min.y >= top) continue;
    if (x + radius <= b.min.x || x - radius >= b.max.x) continue;
    if (z + radius <= b.min.z || z - radius >= b.max.z) continue;
    return false;
  }
  return true;
}

/** 转向：把世界方向转到相对朝向的时钟方位 */
export function clockDirection(fromX, fromZ, facing, targetX, targetZ) {
  const ang = Math.atan2(targetX - fromX, -(targetZ - fromZ));
  let rel = ang - facing;
  rel = ((rel + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const idx = Math.round(((rel + TAU) % TAU) / (TAU / 12)) % 12;
  return idx; // 0 = 12 点方向
}

/** 在网格中寻找最近的可用位置（用于自动避障寻路） */
export function findFreeSpot(grid, x, z, radius, feetY, height, maxR = 6) {
  if (pointFree(grid, x, z, radius, feetY, height)) return { x, z };
  for (let r = 1; r <= maxR; r += 1) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * TAU;
      const nx = x + Math.cos(ang) * r, nz = z + Math.sin(ang) * r;
      if (pointFree(grid, nx, nz, radius, feetY, height)) return { x: nx, z: nz };
    }
  }
  return { x, z };
}
