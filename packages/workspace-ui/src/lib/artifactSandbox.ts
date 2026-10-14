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
  const cs = getComputedStyle(document.documentElement);
  return `${sandboxThemeCss(isDark, (name) => cs.getPropertyValue(name).trim())}html{background:transparent}`;
}

/** Wrap inner HTML into a full sandbox srcdoc in the live theme. */
export function wrapSandboxSrcdoc(inner: string, isDark: boolean, isolated = false): string {
  return wrapSandboxDocument(inner, buildSandboxThemeCss(isDark), isolated);
}
