/* ============================================================
   canvasfit.js — canvas size adaptation
   ------------------------------------------------------------
   Solves three things at once:
     1) backing store = CSS size × devicePixelRatio (no blur after zoom)
     2) ResizeObserver watches container changes (window dragging / layout reflow)
     3) matchMedia(resolution) covers DPR changes (browser zoom)
        — ResizeObserver does not fire when only DPR changes and size stays the same
   ============================================================ */

export function canvasDpr(cap = 2) {
  return Math.min(window.devicePixelRatio || 1, cap);
}

/**
 * Watch element size changes + device pixel ratio changes.
 * cb is called on window resize, browser zoom and layout reflow.
 */
export function watchResize(el, cb) {
  const target = el || document.documentElement;
  let raf = 0;
  const fire = () => {
    if (raf) return;                     // coalesce multiple callbacks within the same frame
    raf = requestAnimationFrame(() => { raf = 0; cb(); });
  };

  const ro = new ResizeObserver(fire);
  ro.observe(target);

  // DPR change fallback: matchMedia fires only once when leaving the current dppx,
  // so it must be re-registered on the new dppx after every trigger.
  let mq = null;
  const onDpr = () => { fire(); arm(); };
  const arm = () => {
    if (mq) mq.removeEventListener('change', onDpr);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', onDpr);
  };
  arm();

  window.addEventListener('orientationchange', fire);

  return {
    disconnect() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      if (mq) mq.removeEventListener('change', onDpr);
      window.removeEventListener('orientationchange', fire);
    },
  };
}
