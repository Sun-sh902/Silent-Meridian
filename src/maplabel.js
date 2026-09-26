/* ============================================================
   maplabel.js — 地图标签放置器（碰撞避让 + 零分配）
   ------------------------------------------------------------
   规则：
     · 调用方按优先级排序（越重要越先提交），先到先得
     · 与已放置的矩形相交则本次拒绝，避免文字糊成一团
     · 内部用固定大小的对象池，每帧 reset() 复用，不产生 GC 抖动
   ============================================================ */

export class LabelPlacer {
  constructor(cap = 64) {
    this.buf = new Array(cap);
    for (let i = 0; i < cap; i++) this.buf[i] = { x: 0, y: 0, w: 0, h: 0 };
    this.n = 0;
    this.rejected = 0;
  }

  reset() { this.n = 0; this.rejected = 0; }

  /** 尝试占位；成功返回 true */
  tryPlace(x, y, w, h, pad = 2) {
    const px = x - pad, py = y - pad, pw = w + pad * 2, ph = h + pad * 2;
    for (let i = 0; i < this.n; i++) {
      const r = this.buf[i];
      if (px < r.x + r.w && px + pw > r.x && py < r.y + r.h && py + ph > r.y) {
        this.rejected++;
        return false;
      }
    }
    if (this.n < this.buf.length) {
      const r = this.buf[this.n++];
      r.x = px; r.y = py; r.w = pw; r.h = ph;
    }
    return true;
  }

  /** 记录一个已占位矩形（用于给固定元素让位，例如玩家图标） */
  reserve(x, y, w, h) { this.tryPlace(x, y, w, h, 0); }
}

/**
 * 带缓存的文字宽度测量：字号固定时同一字符串只测一次。
 * 返回以传入 ctx 当前字体为准的像素宽度。
 */
const widthCache = new Map();
export function measure(ctx, font, text) {
  const key = font + '\u0000' + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (ctx.font !== font) ctx.font = font;
    w = ctx.measureText(text).width;
    if (widthCache.size > 400) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}
