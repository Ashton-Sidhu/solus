// Shared substrate for Solus's sandboxed-iframe renders. The
// conversation artifact card (ArtifactView) wraps untrusted/generated HTML with
// a CSP, a mirror of the live Solus theme variables (the frame can't read
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

// Liberal CSP. The frame exists for fidelity, not for containment: it is the
// one place `<style>` and `<script>` run and the only thing that mirrors the
// workspace theme into a render. Any https origin loads, and a render may
// fetch. What holds the line is the iframe's own sandbox attribute, which
// withholds `allow-same-origin` — the single flag that would let a frame reach
// the workspace DOM, its storage, and its session.
const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; ` +
  `script-src 'unsafe-inline' https:; ` +
  `style-src 'unsafe-inline' https:; ` +
  `img-src data: blob: https:; ` +
  `font-src data: https:; ` +
  `connect-src https:; ` +
  `media-src data: blob: https:">`;

// Reports CONTENT height (document.body, not the viewport) so the host can grow
// the frame to fit without the documentElement.scrollHeight feedback loop.
const RESIZE_REPORTER = `<script>(function(){
  var d = document;
  window.addEventListener("message", function(event){
    if (event.source !== parent || event.data?.type !== "solus-artifact-theme"
        || typeof event.data.css !== "string") return;
    var theme = d.getElementById("solus-artifact-theme");
    if (theme) theme.textContent = event.data.css;
  });
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
})();</script>`;

/** Read the host palette for initial injection and live theme messages. */
export function buildSandboxThemeCss(isDark: boolean): string {
  const cs = getComputedStyle(document.documentElement);
  const decls = THEME_VARS.map((name) => `${name}:${cs.getPropertyValue(name).trim()}`)
    .filter((d) => !d.endsWith(":"))
    .join(";");
  return (
    `:root{color-scheme:${isDark ? "dark" : "light"};${decls}}` +
    // A sandboxed iframe has its own document canvas. Chromium paints that
    // canvas white when the root is transparent, even when the host pane is
    // dark. Paint the root with the mirrored pane colour, but keep the body
    // transparent so artifact markup still has no outer card of its own.
    `html{margin:0;background:var(--solus-container-bg,Canvas);` +
    `color:var(--solus-text-primary);` +
    `font-family:var(--solus-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif);` +
    `font-size: var(--text-sm);line-height:1.5;-webkit-font-smoothing:antialiased;` +
    `scrollbar-width:none;` +
    `text-rendering:optimizeLegibility}` +
    `body{margin:0;background:transparent;color:inherit;font:inherit;}` +
    // A render that caps its own width — a card with a max-width — sat against
    // the left edge of a frame that is as wide as the transcript. Centre every
    // root block: a full-width block is unaffected, and an author's own margin
    // rule on the element still wins, so this is a default and not a fiat.
    `body>*{margin-inline:auto}` +
    `html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}`
  );
}

export function buildSandboxThemeStyle(isDark: boolean): string {
  return `<style id="solus-artifact-theme">${buildSandboxThemeCss(isDark)}</style>`;
}

/** Wrap inner HTML into a full sandbox srcdoc (charset + CSP + theme + resize
 *  reporter). The reporter posts `{ type: "solus-artifact-height", h }`. */
export function wrapSandboxSrcdoc(inner: string, isDark: boolean): string {
  return `<meta charset="utf-8">${CSP_META}${buildSandboxThemeStyle(isDark)}${RESIZE_REPORTER}${inner}`;
}
