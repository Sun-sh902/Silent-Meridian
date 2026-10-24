/* ============================================================
   maplabel.js — map label placer (collision avoidance, zero allocation)
   ------------------------------------------------------------
   Rules:
     · callers submit in priority order (most important first); first come, first served
     · a label that intersects an already placed rect is rejected, so text never piles up
     · fixed-size object pool, reset() every frame, no GC churn
   ============================================================ */

export class LabelPlacer {
  constructor(cap = 64) {
    this.buf = new Array(cap);
    for (let i = 0; i < cap; i++) this.buf[i] = { x: 0, y: 0, w: 0, h: 0 };
    this.n = 0;
    this.rejected = 0;
  }

  reset() { this.n = 0; this.rejected = 0; }

  /** Try to claim a rect; returns true on success */
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

  /** Record an occupied rect (to keep labels off fixed elements such as the player icon) */
  reserve(x, y, w, h) { this.tryPlace(x, y, w, h, 0); }
}

/**
 * Cached text width: at a fixed font size each string is measured once.
 * Returns the pixel width for the ctx's current font.
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
