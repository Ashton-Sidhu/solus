/**
 * The Solus side of beautiful-mermaid: which diagrams it draws, the palette
 * it draws them in, and how its SVG is made safe to place inline in the
 * workspace. Pure, so the worker and the tests share it.
 */

/** A diagram for the worker to draw, and its answer. */
export type NativeDiagramRequest = { requestId: number; source: string };
export type NativeDiagramReply = { requestId: number; svg: string } | { requestId: number; error: string };

// The headers beautiful-mermaid parses. Any other diagram — gantt, pie,
// mindmap, a frontmatter or `%%{init}%%` config — goes to Mermaid, which
// draws everything.
const NATIVE_HEADER =
  /^(?:(?:graph|flowchart)\s+(?:TD|TB|LR|BT|RL)|stateDiagram(?:-v2)?|sequenceDiagram|classDiagram|erDiagram|xychart(?:-beta)?(?:\s.*)?)\s*$/i;

/** Whether beautiful-mermaid can draw this source; otherwise Mermaid does. */
export function drawsNatively(source: string): boolean {
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("%%{")) return false;
    if (line.startsWith("%%")) continue;
    return NATIVE_HEADER.test(line);
  }
  return false;
}

// Variables, not colours: the SVG follows the live theme without a re-render,
// so one drawing serves light and dark mode. Every colour is set: one left
// out falls back to `var(--accent)`, `var(--border)`, and so on, which
// inherit the workspace's own variables of those names — shadcn's hover wash
// drew arrowheads at 6% opacity.
export const NATIVE_DIAGRAM_OPTIONS = {
  bg: "var(--solus-container-bg)",
  fg: "var(--solus-text-primary)",
  line: "var(--solus-text-tertiary)",
  accent: "var(--solus-text-secondary)",
  muted: "var(--solus-text-secondary)",
  surface: "var(--solus-container-bg)",
  border: "var(--solus-tool-border)",
  font: "system-ui",
  transparent: true,
};

/**
 * beautiful-mermaid writes a standalone SVG. Inline in the workspace, its
 * `<style>` would apply to every SVG on the page and fetch a web font, and
 * its marker ids would collide with the next diagram's. Each style block is
 * scoped to its own SVG, the font import is dropped, and every id is
 * prefixed.
 */
export function scopeDiagramSvg(svg: string, idPrefix: string): string {
  return svg
    .replace(/<style>([\s\S]*?)<\/style>/g, (_, css: string) => {
      const scoped = css
        .replace(/^\s*@import[^\n]*\n?/gm, "")
        // Inside `@scope`, `svg` would not match the root; `:scope` does.
        .replace(/(^|[\s,}])svg(?=\s*\{)/g, "$1:scope");
      return `<style>@scope {${scoped}}</style>`;
    })
    .replace(/(\s)id="([^"]+)"/g, `$1id="${idPrefix}-$2"`)
    .replace(/="url\(#([^)]+)\)"/g, `="url(#${idPrefix}-$1)"`);
}
