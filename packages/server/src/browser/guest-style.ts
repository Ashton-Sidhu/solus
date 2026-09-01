/**
 * Solus's own scrollbar, injected into every browser guest.
 *
 * The guest is a separate document that never loads the renderer's `index.css`,
 * so left alone it paints Chromium's default chunky bar — the one thing on the
 * page that does not read as part of Solus. This restates the app's scrollbar as
 * a plain stylesheet inside the guest so the browser's bar matches the rest of
 * the app, on the native `<webview>` and — because a streamed frame is a capture
 * of this same guest — on the streamed surface too.
 *
 * It is deliberately static: a thin, rounded, overlay-style thumb that is always
 * visible, darkens on hover, and follows the emulated `prefers-color-scheme` for
 * light and dark. The renderer hides its own thumb until the scroller moves, but
 * that reveal needs a scroll listener stamping state onto the element, and
 * driving that into an arbitrary guest proved unreliable. A quietly-present
 * hairline is the honest, robust match here.
 *
 * Dimensions are px, not the app's rem: the guest's root font size belongs to
 * the site, and the bar must be the same width whatever that site chose.
 */

/** Marks the injected sheet and guards re-injection. Namespaced so a page's own
 *  ids and globals cannot collide with it. */
const STYLE_ID = '__solus-browser-scrollbar'
const INSTALLED_FLAG = '__solusBrowserScrollbar'

const GUEST_SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.18);
  background-clip: padding-box;
  border: 3px solid transparent;
  border-radius: 9999px;
  min-height: 32px;
}
::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.32); background-clip: padding-box; }
@media (prefers-color-scheme: dark) {
  ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.32); background-clip: padding-box; }
}`

/**
 * The install script, run in the guest page.
 *
 * Idempotent by construction: a page navigates and reloads on its own schedule,
 * and the same source is both installed on every new document and evaluated once
 * on the one already loaded, so it must be safe to run twice. It returns nothing;
 * it is injected for its effect, not for a value.
 */
export function browserGuestStyleScript(): string {
  return `(() => {
  if (window[${JSON.stringify(INSTALLED_FLAG)}]) return;
  window[${JSON.stringify(INSTALLED_FLAG)}] = true;
  const STYLE_ID = ${JSON.stringify(STYLE_ID)};
  const CSS = ${JSON.stringify(GUEST_SCROLLBAR_CSS)};
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const root = document.head || document.documentElement;
    if (!root) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    root.appendChild(style);
  };
  ensureStyle();
  // At document-start the <head> may not exist yet; catch that document once.
  if (!document.getElementById(STYLE_ID)) {
    document.addEventListener('DOMContentLoaded', ensureStyle, { once: true });
  }
})()`
}
