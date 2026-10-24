/* ============================================================
   canvasfit.js — canvas sizing
   ------------------------------------------------------------
   Handles three things in one place:
     1) backing store = CSS size × devicePixelRatio (stays sharp when zoomed)
     2) ResizeObserver on the container (window drag / layout reflow)
     3) matchMedia(resolution) as a fallback for DPR changes (browser zoom)
        — ResizeObserver does not fire when only DPR changes and the size doesn't
   ============================================================ */

export function canvasDpr(cap = 2) {
  return Math.min(window.devicePixelRatio || 1, cap);
}

/**
 * Watch element size and device-pixel-ratio changes.
 * cb fires on window resize, browser zoom and layout reflow.
 */
export function watchResize(el, cb) {
  const target = el || document.documentElement;
  let raf = 0;
  const fire = () => {
    if (raf) return;                     // coalesce multiple callbacks within one frame
    raf = requestAnimationFrame(() => { raf = 0; cb(); });
  };

  const ro = new ResizeObserver(fire);
  ro.observe(target);

  // DPR fallback: matchMedia on the current dppx only fires once, on leaving it,
  // so re-register against the new dppx after every change.
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
