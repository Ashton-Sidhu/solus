// Shared substrate for Solus's sandboxed-iframe renders (ADR-0003). The
// conversation artifact card (ArtifactView) wraps untrusted/generated HTML with
// a strict CSP, a mirror of the live Solus theme variables (the frame can't read
// the host's CSS without allow-same-origin), and a height-reporting loop so the
// frame can grow to its content. Kept here as a cross-feature utility.

// Solus palette mirrored into the sandboxed frame so the render can drive
// colours off `var(--solus-…)` and sit flush in the app's theme.
const THEME_VARS = [
  '--solus-container-bg',
  '--solus-container-bg-collapsed',
  '--solus-surface-primary',
  '--solus-surface-secondary',
  '--solus-text-primary',
  '--solus-text-secondary',
  '--solus-text-tertiary',
  '--solus-accent',
  '--solus-accent-light',
  '--solus-accent-soft',
  '--solus-accent-border',
  '--solus-accent-border-medium',
  '--solus-tool-border',
  '--solus-font-family',
  // Warm artifact palette — parchment neutrals + brand-coherent categorical
  // data colours, so renders never fall back to generic grey/rainbow.
  '--solus-art-surface',
  '--solus-art-raised',
  '--solus-art-border',
  '--solus-art-border-strong',
  '--solus-art-1',
  '--solus-art-2',
  '--solus-art-3',
  '--solus-art-4',
  '--solus-art-5',
  '--solus-art-6',
  '--solus-art-positive',
  '--solus-art-negative',
];

// Strict CSP: inline script/style for the render's own interactivity, images +
// libs only from the CDN allowlist, connect-src 'none' so nothing exfiltrates.
const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; ` +
  `script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; ` +
  `style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; ` +
  `img-src data: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; ` +
  `font-src data: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; ` +
  `connect-src 'none'">`;

// Reports CONTENT height (document.body, not the viewport) so the host can grow
// the frame to fit without the documentElement.scrollHeight feedback loop.
const RESIZE_REPORTER = `<script>(function(){
  var d = document;
  function measure(){
    var b = d.body;
    return b ? Math.max(b.scrollHeight, b.offsetHeight)
             : (d.documentElement ? d.documentElement.scrollHeight : 0);
  }
  function report(){
    try { parent.postMessage({ type: "solus-artifact-height", h: measure() }, "*"); } catch (e) {}
  }
  function start(){
    var target = d.body || d.documentElement;
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(report).observe(target);
    report();
  }
  if (d.readyState !== "loading") start();
  else d.addEventListener("DOMContentLoaded", start);
  window.addEventListener("load", report);
  window.addEventListener("resize", report);
  setTimeout(report, 50);
})();<\/script>`;

/** Resolve the live theme's variable values for injection into the frame. Must
 *  run in the renderer (reads `document.documentElement`). Reference `isDark`
 *  from a reactive scope to regenerate the srcdoc when the theme flips. */
export function buildSandboxThemeStyle(isDark: boolean): string {
  const cs = getComputedStyle(document.documentElement);
  const decls = THEME_VARS.map((name) => `${name}:${cs.getPropertyValue(name).trim()}`)
    .filter((d) => !d.endsWith(":"))
    .join(";");
  return (
    `<style>:root{color-scheme:${isDark ? "dark" : "light"};${decls}}` +
    // Transparent body so any space the render leaves shows the host background
    // through; text/font default to the app's so bare markup already matches.
    `html,body{margin:0;background:transparent;` +
    `color:var(--solus-text-primary);` +
    `font-family:var(--solus-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif);` +
    `font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;` +
    `scrollbar-width:none;` +
    `text-rendering:optimizeLegibility}` +
    `html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}</style>`
  );
}

/** Wrap inner HTML into a full sandbox srcdoc (charset + CSP + theme + resize
 *  reporter). The reporter posts `{ type: "solus-artifact-height", h }`. */
export function wrapSandboxSrcdoc(inner: string, isDark: boolean): string {
  return `<meta charset="utf-8">${CSP_META}${buildSandboxThemeStyle(isDark)}${RESIZE_REPORTER}${inner}`;
}
