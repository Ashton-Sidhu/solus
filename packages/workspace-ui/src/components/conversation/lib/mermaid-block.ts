import type { Mermaid } from "mermaid";
import { fenceLanguage } from "./html-block";

/**
 * How a fenced ```mermaid block reads in a reply or a document.
 *
 * A Mermaid fence is a diagram to look at, so a settled fence renders on its
 * own. The one way out is the info string: ```mermaid source keeps it as code,
 * the same word an html fence uses. There is no content test, because Mermaid
 * text has no reading other than "draw this".
 */
export type MermaidRenderMode = "diagram" | "source";

export function isMermaidFence(info: string | undefined): boolean {
  return fenceLanguage(info) === "mermaid";
}

export function mermaidRenderMode(info: string | undefined): MermaidRenderMode {
  const directives = (info ?? "").trim().toLowerCase().split(/\s+/).slice(1);
  return directives.includes("source") ? "source" : "diagram";
}

/** The info string a diagram turns into when the reader asks to read it as
 *  code. `source` is what stops the next parse from rendering it again. */
export const MERMAID_SOURCE_INFO = "mermaid source";

export type MermaidResult = { svg: string; error?: undefined } | { svg?: undefined; error: string };

// The variables Mermaid's `base` theme is built from, read off the live Solus
// palette so a diagram sits flush with the pane in either mode.
function themeVariables(isDark: boolean) {
  const styles = getComputedStyle(document.documentElement);
  // A variable the stylesheet does not define is left to Mermaid's own default
  // rather than handed over as an empty colour.
  const read = (name: `--solus-${string}`) => styles.getPropertyValue(name).trim() || undefined;
  return {
    darkMode: isDark,
    background: read("--solus-container-bg"),
    primaryColor: read("--solus-accent-soft"),
    primaryTextColor: read("--solus-text-primary"),
    primaryBorderColor: read("--solus-accent-border-medium"),
    secondaryColor: read("--solus-surface-secondary"),
    tertiaryColor: read("--solus-surface-primary"),
    lineColor: read("--solus-text-secondary"),
    textColor: read("--solus-text-primary"),
    // Edge labels sit on the pane, not in a grey pill.
    edgeLabelBackground: read("--solus-container-bg"),
    clusterBkg: read("--solus-surface-primary"),
    clusterBorder: read("--solus-tool-border"),
    noteBkgColor: read("--solus-surface-secondary"),
    noteTextColor: read("--solus-text-primary"),
    fontFamily: read("--solus-font-family"),
    fontSize: "13px",
  };
}

// A Mermaid diagram is drawn to look like a Solus diagram work. Every value
// below is lifted from the diagram canvas — `DiagramNode.svelte`,
// `DiagramGroupNode.svelte`, `DiagramEdge.svelte`, `DiagramShell.css` — so
// the two read as one artifact family: a node is a container-coloured card
// with a hairline border and the faint ambient lift; a group is the
// accent-washed frame; edges are parchment ink a step lighter than text, with
// a label pill on the pane. The rules go in through `themeCSS`, which Mermaid
// nests under the SVG's own id, so they outrank its defaults without
// `!important`, and the SVG is inline in the document so the theme variables
// resolve in both modes. The edge ink is literal because Mermaid namespaces
// every rule under the SVG id, so a variable declared here could not reach a
// root the diagram canvas would set it on.
function solusMermaidCss(isDark: boolean): string {
  const edgeStroke = isDark ? "rgba(255, 255, 255, 0.34)" : "#c3b7a6";
  const edgeArrow = isDark ? "rgba(255, 255, 255, 0.5)" : "#a89a88";
  const edgeLabel = isDark ? "var(--solus-text-secondary)" : "var(--solus-text-tertiary)";
  const nodeLift = isDark ? "none" : "drop-shadow(0 1px 2px rgba(60, 40, 25, 0.05))";
  return `
    .node rect, .node circle, .node ellipse, .node polygon, .node path {
      fill: var(--solus-container-bg);
      stroke: var(--solus-tool-border);
      stroke-width: 1px;
      filter: ${nodeLift};
    }
    .node rect, .node .label-container { rx: 10px; ry: 10px; }
    .cluster rect {
      fill: color-mix(in srgb, var(--solus-accent) 6%, var(--solus-container-bg));
      stroke: color-mix(in srgb, var(--solus-accent) 28%, transparent);
      stroke-width: 1px;
      rx: 16px; ry: 16px;
      filter: none;
    }
    .node .label, .nodeLabel, .node text {
      fill: var(--solus-text-primary);
      color: var(--solus-text-primary);
      font-size: 14px;
      font-weight: 500;
    }
    .cluster text, .cluster-label text {
      fill: var(--solus-text-secondary);
      color: var(--solus-text-secondary);
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .edgePath .path, .flowchart-link, .messageLine0, .messageLine1, .transition, .relation {
      stroke: ${edgeStroke};
      stroke-width: 1.3px;
    }
    .marker, marker path {
      fill: ${edgeArrow};
      stroke: none;
    }
    .edgeLabel, .edgeLabel p, .edgeLabel text {
      fill: ${edgeLabel};
      color: ${edgeLabel};
      font-size: 12px;
      font-weight: 500;
    }
    .edgeLabel rect, .edgeLabel .label-container {
      fill: var(--solus-container-bg);
      stroke: none;
      opacity: 1;
      rx: 5px; ry: 5px;
    }
  `;
}

// Mermaid is a large chunk. It loads on the first diagram and never before.
let mermaidLoader: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  mermaidLoader ??= import("mermaid").then((module) => module.default);
  return mermaidLoader;
}

/** Start fetching Mermaid before it is needed: a fence that is still
 *  streaming will close in a moment, and the chunk should be warm by then. */
export function preloadMermaid(): void {
  void loadMermaid().catch(() => { /* The render path reports the failure. */ });
}

// `initialize` re-reads the palette and re-parses the theme CSS, so it runs
// once per theme rather than once per diagram.
let initializedFor: "dark" | "light" | null = null;
function configureMermaid(mermaid: Mermaid, isDark: boolean): void {
  const theme = isDark ? "dark" : "light";
  if (initializedFor === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // A failed parse must not leave Mermaid's own error graphic in the DOM.
    suppressErrorRendering: true,
    theme: "base",
    look: "classic",
    themeVariables: themeVariables(isDark),
    themeCSS: solusMermaidCss(isDark),
    // Dagre, not ELK: ELK is a 1.4 MB chunk for a layout these diagrams
    // do not need.
    layout: "dagre",
    // SVG text, not foreignObject: HTML labels are measured against a
    // font the pane may not have, and the mismatch clips "Questions and
    // results" to "Questions and". SVG text measures what it draws.
    htmlLabels: false,
    flowchart: {
      // Mermaid 12 gives flowcharts their own "neo" look and colour theme
      // over the global one; restate both so the palette above applies.
      theme: "base",
      look: "classic",
      curve: "basis",
      nodeSpacing: 36,
      rankSpacing: 44,
      padding: 12,
    },
  });
  initializedFor = theme;
}

// One render at a time: `initialize` is global state, so two renders with
// different themes in flight would paint one of them with the other's palette.
let queue: Promise<unknown> = Promise.resolve();
let renderSequence = 0;

// Keyed by theme and source. A re-mounted tab, a second reader of the same
// message, or a flip back to a previous theme costs nothing.
const results = new Map<string, Promise<MermaidResult>>();

/** The message Mermaid's parser raised, without the caret diagram that only
 *  reads in a monospace pane. */
function describeError(message: string): string {
  const lines = message.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const expecting = lines.find((line) => line.startsWith("Expecting"));
  return expecting ? `${lines[0]} ${expecting}` : (lines[0] ?? "Mermaid could not draw this diagram.");
}

/** Render Mermaid text to SVG for the current theme. Never throws: a diagram
 *  that does not parse resolves to its error so the block can stay as source. */
export function renderMermaid(source: string, isDark: boolean): Promise<MermaidResult> {
  const key = `${isDark ? "dark" : "light"}\n${source}`;
  const cached = results.get(key);
  if (cached) return cached;

  const pending = queue.then(async (): Promise<MermaidResult> => {
    try {
      const mermaid = await loadMermaid();
      configureMermaid(mermaid, isDark);
      const { svg } = await mermaid.render(`solus-mermaid-${++renderSequence}`, source);
      return { svg };
    } catch (error) {
      return { error: describeError(error instanceof Error ? error.message : String(error)) };
    }
  });
  queue = pending;
  results.set(key, pending);
  return pending;
}
