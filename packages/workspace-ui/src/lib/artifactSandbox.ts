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
  // Artifact palette — ivory neutrals + brand-coherent categorical
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

// Strict CSP for HTML that someone other than the user can influence. A review
// lens is authored by an agent that read a pull request, and a pull request can
// carry instructions from anyone. No network at all: the render cannot send
// the diff it describes anywhere. A later <meta> CSP in the render can only
// narrow this, never widen it. What stays open: the frame can still navigate
// itself, which no CSP directive closes (docs/plans/review-lenses.md).
const ISOLATED_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; ` +
  `script-src 'unsafe-inline'; ` +
  `style-src 'unsafe-inline'; ` +
  `img-src data: blob:; ` +
  `font-src data:; ` +
  `media-src data: blob:; ` +
  `connect-src 'none'; ` +
  `form-action 'none'; ` +
  `base-uri 'none'">`;

// Answers "what is under this point?" for the lens comment pin: the nearest
// element that names a place in the change, and its text for the quote. The
// render can forge the answer, so the host treats it as untrusted text and
// checks the path and line against the diff before it drafts anything.
const ANCHOR_RESPONDER = `<script>(function(){
  window.addEventListener("message", function(event){
    var data = event.data;
    if (event.source !== parent || !data || data.type !== "solus-lens-anchor-query") return;
    var el = document.elementFromPoint(data.x, data.y);
    var anchor = el && el.closest ? el.closest("[data-solus-file]") : null;
    var target = anchor || el;
    var text = target ? String(target.innerText || target.textContent || "").trim().slice(0, 280) : "";
    var line = anchor ? parseInt(anchor.getAttribute("data-solus-line") || "", 10) : NaN;
    parent.postMessage({
      type: "solus-lens-anchor", id: data.id, text: text,
      path: anchor ? anchor.getAttribute("data-solus-file") : null,
      line: isNaN(line) ? null : line
    }, "*");
  });
})();</script>`;

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
    var b = d.body, root = d.documentElement;
    if (!b) return root ? root.scrollHeight : 0;
    // A first or last child's margin collapses through body, so body's own
    // height misses it; the root box holds it. Body's top offset plus its
    // scrollHeight still counts content that overflows a root pinned to 100%.
    var top = b.getBoundingClientRect().top + (window.scrollY || 0);
    return Math.max(root.getBoundingClientRect().height,
                    top + Math.max(b.scrollHeight, b.offsetHeight));
  }
  function report(){
    try { parent.postMessage({ type: "solus-artifact-height", h: measure() }, "*"); } catch (e) {}
  }
  // Nothing reports before the document is parsed: this script runs ahead
  // of the render's own markup, and a render whose <script src> blocks the
  // parser would report a half-built page, then grow once it finished.
  function start(){
    var target = d.body || d.documentElement;
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(report).observe(target);
    report();
    setTimeout(report, 50);
    window.addEventListener("resize", report);
  }
  if (d.readyState !== "loading") start();
  else d.addEventListener("DOMContentLoaded", start);
  window.addEventListener("load", report);
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
    // The frame grows to the document, so the document never scrolls. Hidden
    // overflow keeps a wheel over the render from latching onto an invisible
    // inner scroller instead of moving the transcript.
    `overflow:hidden;scrollbar-width:none;` +
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
 *  reporter). The reporter posts `{ type: "solus-artifact-height", h }`.
 *  `isolated` swaps in the no-network CSP and adds the lens anchor responder. */
export function wrapSandboxSrcdoc(inner: string, isDark: boolean, isolated = false): string {
  const csp = isolated ? ISOLATED_CSP_META : CSP_META;
  const responder = isolated ? ANCHOR_RESPONDER : "";
  return `<meta charset="utf-8">${csp}${buildSandboxThemeStyle(isDark)}${RESIZE_REPORTER}${responder}${inner}`;
}
