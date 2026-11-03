/*
 * Classic boot check (no imports, no inline code; CSP `script-src 'self'`).
 *
 * The application module sets `window.__HM2B_BOOTED__` once its feature probe
 * passes. If that never happens (ESM, JSON import attributes or another
 * required primitive is missing), this fallback surfaces the CLI commands
 * instead of failing silently. No user-agent sniffing.
 */
(function bootCheck() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  function inferReasons() {
    const reasons = [];
    if (typeof window.DecompressionStream !== 'function') reasons.push('DecompressionStream');
    if (!(window.crypto && window.crypto.subtle)) reasons.push('crypto.subtle');
    if (typeof window.TextDecoder !== 'function') reasons.push('TextDecoder');
    if (typeof window.fetch !== 'function') reasons.push('fetch');
    if (typeof window.Blob !== 'function') reasons.push('Blob');
    if (reasons.length === 0) reasons.push('ESM / JSON import attributes did not start the application');
    return reasons;
  }

  function showFallback(reasons) {
    const fatal = document.getElementById('fatal');
    const list = document.getElementById('fatal-reasons');
    if (fatal === null) return;
    if (list !== null) {
      const items = Array.isArray(reasons) && reasons.length > 0 ? reasons : inferReasons();
      list.textContent = `Missing or unsupported: ${items.join(', ')}.`;
    }
    fatal.hidden = false;
  }

  window.__hm2bShowFallback = showFallback;
  window.setTimeout(function () {
    if (window.__HM2B_BOOTED__ === true) return;
    showFallback(window.__HM2B_BOOT_REASONS__);
  }, 5000);
}());
