/* ============================================================
   canvasfit.js — Canvas 尺寸适配
   ------------------------------------------------------------
   统一解决三件事：
     1) backing store = CSS 尺寸 × devicePixelRatio（缩放后不模糊）
     2) 用 ResizeObserver 监听容器变化（拖动窗口 / 布局重排）
     3) 用 matchMedia(resolution) 兜底 DPR 变化（浏览器缩放）
        —— 仅改 DPR、不改尺寸时 ResizeObserver 不会触发
   ============================================================ */

export function canvasDpr(cap = 2) {
  return Math.min(window.devicePixelRatio || 1, cap);
}

/**
 * 监听元素尺寸变化 + 设备像素比变化。
 * cb 会在窗口缩放、浏览器缩放、布局重排时被调用。
 */
export function watchResize(el, cb) {
  const target = el || document.documentElement;
  let raf = 0;
  const fire = () => {
    if (raf) return;                     // 合并同一帧内的多次回调
    raf = requestAnimationFrame(() => { raf = 0; cb(); });
  };

  const ro = new ResizeObserver(fire);
  ro.observe(target);

  // DPR 变化兜底：matchMedia 在当前 dppx 上只会「离开时」触发一次，
  // 所以每次触发后都要重新注册到新的 dppx。
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
