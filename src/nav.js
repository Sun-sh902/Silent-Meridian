/* ============================================================
   nav.js — 粗粒度导航网格 + A* 寻路
   ============================================================ */
import { pointFree, losBlocked } from './geom.js';

export class NavGrid {
  constructor(grid, bounds, cell = 1.5, inflate = 0.62) {
    this.grid = grid;
    this.bounds = bounds;
    this.cell = cell;
    this.cx0 = Math.floor(bounds.x0 / cell);
    this.cz0 = Math.floor(bounds.z0 / cell);
    this.w = Math.ceil((bounds.x1 - bounds.x0) / cell) + 1;
    this.h = Math.ceil((bounds.z1 - bounds.z0) / cell) + 1;
    this.blocked = new Uint8Array(this.w * this.h);
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = (this.cx0 + i) * cell, z = (this.cz0 + j) * cell;
        this.blocked[j * this.w + i] = pointFree(grid, x, z, inflate, 0, 1.75) ? 0 : 1;
      }
    }
    this._open = [];
    this._came = new Int32Array(this.w * this.h);
    this._g = new Float32Array(this.w * this.h);
    this._f = new Float32Array(this.w * this.h);
    this._closed = new Uint8Array(this.w * this.h);
    this._stamp = new Int32Array(this.w * this.h);
    this._epoch = 0;
  }
  idx(i, j) { return j * this.w + i; }
  cellOf(x, z) {
    return {
      i: Math.min(this.w - 1, Math.max(0, Math.round(x / this.cell) - this.cx0)),
      j: Math.min(this.h - 1, Math.max(0, Math.round(z / this.cell) - this.cz0)),
    };
  }
  world(i, j) { return { x: (this.cx0 + i) * this.cell, z: (this.cz0 + j) * this.cell }; }
  isBlocked(i, j) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return true;
    return this.blocked[j * this.w + i] === 1;
  }
  /** 找到距离目标最近的可通行格 */
  nearestFree(x, z, maxR = 14) {
    const c = this.cellOf(x, z);
    if (!this.isBlocked(c.i, c.j)) return c;
    for (let r = 1; r <= maxR; r++) {
      for (let di = -r; di <= r; di++) {
        for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = c.i + di, j = c.j + dj;
          if (!this.isBlocked(i, j)) return { i, j };
        }
      }
    }
    return c;
  }
  /** A*；返回世界坐标航点数组（省略起点） */
  findPath(ax, az, bx, bz, maxNodes = 5200) {
    const s = this.nearestFree(ax, az);
    const t = this.nearestFree(bx, bz);
    const si = this.idx(s.i, s.j), ti = this.idx(t.i, t.j);
    if (si === ti) return [{ x: bx, z: bz }];
    const ep = ++this._epoch;
    const open = this._open;
    open.length = 0;
    const g = this._g, f = this._f, came = this._came, closed = this._closed, stamp = this._stamp;
    stamp[si] = ep; g[si] = 0;
    f[si] = Math.hypot(t.i - s.i, t.j - s.j);
    open.push(si);
    let found = false, visited = 0;
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    while (open.length) {
      // 取 f 最小（线性扫描足够，节点规模小）
      let best = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[best]]) best = i;
      const cur = open[best];
      open[best] = open[open.length - 1]; open.pop();
      if (cur === ti) { found = true; break; }
      if (stamp[cur] !== ep) continue;
      if (closed[cur] === ep) continue;
      closed[cur] = ep;
      if (++visited > maxNodes) break;
      const ci = cur % this.w, cj = (cur / this.w) | 0;
      for (const [di, dj] of DIRS) {
        const ni = ci + di, nj = cj + dj;
        if (this.isBlocked(ni, nj)) continue;
        if (di && dj && (this.isBlocked(ci + di, cj) || this.isBlocked(ci, cj + dj))) continue;
        const nIdx = this.idx(ni, nj);
        if (closed[nIdx] === ep) continue;
        const step = (di && dj) ? 1.4142 : 1;
        const ng = g[cur] + step;
        if (stamp[nIdx] !== ep) { stamp[nIdx] = ep; g[nIdx] = Infinity; }
        if (ng < g[nIdx]) {
          g[nIdx] = ng;
          f[nIdx] = ng + Math.hypot(t.i - ni, t.j - nj);
          came[nIdx] = cur;
          open.push(nIdx);
          if (open.length > 4200) break;
        }
      }
    }
    if (!found) return null;
    // 回溯
    const raw = [];
    let cur = ti;
    while (cur !== si) {
      const i = cur % this.w, j = (cur / this.w) | 0;
      raw.push(this.world(i, j));
      cur = came[cur];
      if (raw.length > 4000) break;
    }
    raw.reverse();
    raw.push({ x: bx, z: bz });
    return this.smooth(ax, az, raw);
  }
  /** 拉绳平滑 */
  smooth(sx, sz, pts) {
    const out = [];
    let cx = sx, cz = sz, i = 0;
    let guard = 0;
    while (i < pts.length && guard++ < 400) {
      let j = pts.length - 1;
      for (; j > i; j--) {
        if (this.clearWorld(cx, cz, pts[j].x, pts[j].z)) break;
      }
      out.push(pts[j]);
      cx = pts[j].x; cz = pts[j].z;
      i = j + 1;
    }
    return out;
  }
  clearWorld(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(d / (this.cell * 0.6)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const c = this.cellOf(x, z);
      if (this.isBlocked(c.i, c.j)) return false;
    }
    return true;
  }
}

/** 视线（世界坐标），复用 geom 的采样实现 */
export function hasLOS(grid, ax, ay, az, bx, by, bz) {
  return !losBlocked(grid, ax, ay, az, bx, by, bz);
}
