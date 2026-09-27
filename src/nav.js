/* ============================================================
   nav.js — 粗粒度导航网格 + A* 寻路
   ============================================================ */
import { pointFree, losBlocked } from './geom.js';

export class NavGrid {
  /* 8 邻域方向表：静态常量，避免每次 findPath 重建数组 */
  static DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

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
    /* open list 改用二叉堆：原先每次取最小 f 都要线性扫描整个 open 数组，
       最坏 O(n) 次比较 × n 次弹出。节点规模不大时线性扫描勉强可用，
       但掩体/追击路径会频繁重算，这里换成 O(log n) 的堆。
       堆按索引存节点，键直接读 _f 表，因此不需要额外的键数组。 */
    this._heap = new Int32Array(this.w * this.h * 2 + 64);
    this._heapN = 0;
    this._came = new Int32Array(this.w * this.h);
    this._g = new Float32Array(this.w * this.h);
    this._f = new Float32Array(this.w * this.h);
    this._closed = new Uint8Array(this.w * this.h);
    this._stamp = new Int32Array(this.w * this.h);
    this._epoch = 0;
  }
  idx(i, j) { return j * this.w + i; }

  /* ---- 二叉最小堆（键 = this._f[idx]） ---- */
  _heapPush(idx) {
    const h = this._heap, f = this._f;
    if (this._heapN >= h.length) return;      // 堆满则丢弃（有 maxNodes 兜底）
    let i = this._heapN++;
    h[i] = idx;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[h[p]] <= f[h[i]]) break;
      const t = h[p]; h[p] = h[i]; h[i] = t;
      i = p;
    }
  }
  _heapPop() {
    const h = this._heap, f = this._f;
    const top = h[0];
    const n = --this._heapN;
    h[0] = h[n];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < n && f[h[l]] < f[h[m]]) m = l;
      if (r < n && f[h[r]] < f[h[m]]) m = r;
      if (m === i) break;
      const t = h[m]; h[m] = h[i]; h[i] = t;
      i = m;
    }
    return top;
  }
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
    this._heapN = 0;
    const g = this._g, f = this._f, came = this._came, closed = this._closed, stamp = this._stamp;
    stamp[si] = ep; g[si] = 0;
    f[si] = Math.hypot(t.i - s.i, t.j - s.j);
    this._heapPush(si);
    let found = false, visited = 0;
    /* 方向表提到循环外，避免每次搜索重建（原先每次 findPath 都新建一个数组） */
    const DIRS = NavGrid.DIRS;
    while (this._heapN > 0) {
      const cur = this._heapPop();
      if (cur === ti) { found = true; break; }
      if (closed[cur] === ep) continue;      // 堆里可能存在重复项，弹出时判重
      closed[cur] = ep;
      if (++visited > maxNodes) break;
      const ci = cur % this.w, cj = (cur / this.w) | 0;
      for (let k = 0; k < 8; k++) {
        const di = DIRS[k][0], dj = DIRS[k][1];
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
          this._heapPush(nIdx);
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
