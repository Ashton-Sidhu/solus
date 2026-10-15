// The client side of the sandboxed-iframe page: it fills the shared theme
// (`@solus/contracts/artifact-sandbox`) from the live document, so a render
// follows the user's theme. The frame cannot read the host's CSS itself
// without allow-same-origin.
import { sandboxThemeCss, wrapSandboxDocument } from "@solus/contracts/artifact-sandbox";

/** Read the host palette for initial injection and live theme messages. The
 *  root is transparent, so a render has no background of its own and shows
 *  whatever surface holds the frame. Chromium keeps the frame canvas
 *  transparent only while the iframe's color-scheme matches the document's;
 *  SandboxFrame sets both from the same theme. */
export function buildSandboxThemeCss(isDark: boolean): string {
  const root = document.documentElement;
  // Every theme setting lands on the root's classes or inline style
  // (`settings-display.ts`). Reading those costs nothing; reading the computed
  // palette forces a style recalculation of the whole document, so it runs once
  // per theme change and not once per frame.
  const key = `${isDark}|${root.className}|${root.getAttribute("style") ?? ""}`;
  if (palette?.root === root && palette.key === key) return palette.css;
  const cs = getComputedStyle(root);
  const css = `${sandboxThemeCss(isDark, (name) => cs.getPropertyValue(name).trim())}html,body{background:transparent!important}`;
  palette = { root, key, css };
  return css;
}

let palette: { root: Element; key: string; css: string } | null = null;

/** Wrap inner HTML into a full sandbox srcdoc in the live theme. */
export function wrapSandboxSrcdoc(inner: string, isDark: boolean, isolated = false): string {
  return wrapSandboxDocument(inner, buildSandboxThemeCss(isDark), isolated);
}
