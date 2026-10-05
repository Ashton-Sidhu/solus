import type { Mermaid } from "mermaid";
import { drawsNatively, type NativeDiagramReply, type NativeDiagramRequest } from "./mermaid-svg";

/** How a fenced ```mermaid block reads is the document model's rule, so a
 *  reply and a document make the same choice. */
export { isMermaidFence, mermaidRenderMode, MERMAID_SOURCE_INFO, type MermaidRenderMode } from "@solus/document-model/fences";

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

// Mermaid wraps a label by measuring it word by word: it inserts a test
// <text>, reads its length, and removes it, over a hundred times for a small
// flowchart. Each read forces a style recalculation of the document it is in,
// and in the workspace that is the whole visible page — about 4 ms each, so
// half a second per diagram on the main thread. Mermaid looks its diagram up
// through the global `document`, so it cannot simply draw into another one.
// Instead it runs in its own realm, in a hidden same-origin frame whose
// document holds only the diagram, and hands back the SVG string.
async function loadFrameMermaid(): Promise<Mermaid> {
  const { default: entryUrl } = await import("./mermaid-frame?worker&url");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Laid out but never seen: Mermaid measures text, so the frame cannot be
  // `display: none`.
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0;visibility:hidden;pointer-events:none";
  document.body.append(frame);
  const frameWindow = frame.contentWindow;
  const frameDocument = frame.contentDocument;
  if (!frameWindow || !frameDocument) throw new Error("Mermaid could not start.");
  const script = frameDocument.createElement("script");
  script.type = "module";
  script.src = new URL(entryUrl, document.baseURI).href;
  await new Promise<void>((resolve, reject) => {
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Mermaid could not load."));
    frameDocument.head.append(script);
  });
  // A module script's load event fires after the module has run.
  const mermaid = frameWindow.solusMermaid;
  if (!mermaid) throw new Error("Mermaid could not load.");
  return mermaid;
}

// Mermaid is a large chunk. It loads on the first diagram and never before.
let mermaidLoader: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  mermaidLoader ??= loadFrameMermaid();
  return mermaidLoader;
}

// Most diagrams an agent writes — flowcharts, sequence, state, class, ER, and
// xy charts — are drawn by beautiful-mermaid in a worker: no DOM, a few
// milliseconds each, and nothing on the main thread. Mermaid in the frame
// draws the rest, and anything the worker cannot parse.
let nativeWorker: Worker | null = null;
let nativeWorkerFailed = false;
let nativeRequestSequence = 0;
const nativeRequests = new Map<number, (svg: string | null) => void>();

function startNativeWorker(): Worker | null {
  if (nativeWorker || nativeWorkerFailed) return nativeWorker;
  try {
    nativeWorker = new Worker(new URL("./mermaid-svg.worker.ts", import.meta.url), { type: "module" });
  } catch {
    nativeWorkerFailed = true;
    return null;
  }
  nativeWorker.onmessage = (event: MessageEvent<NativeDiagramReply>) => {
    const reply = event.data;
    nativeRequests.get(reply.requestId)?.("svg" in reply ? reply.svg : null);
    nativeRequests.delete(reply.requestId);
  };
  // A worker that cannot load hands every diagram, now and later, to Mermaid.
  nativeWorker.onerror = () => {
    nativeWorkerFailed = true;
    nativeWorker?.terminate();
    nativeWorker = null;
    for (const settle of nativeRequests.values()) settle(null);
    nativeRequests.clear();
  };
  return nativeWorker;
}

// Keyed by source alone: the SVG draws in theme variables, so one drawing
// serves both themes.
const nativeResults = new Map<string, Promise<string | null>>();

/** The diagram drawn by beautiful-mermaid, or null when Mermaid must draw it. */
function drawNatively(source: string): Promise<string | null> {
  if (!drawsNatively(source)) return Promise.resolve(null);
  const cached = nativeResults.get(source);
  if (cached) return cached;
  const worker = startNativeWorker();
  if (!worker) return Promise.resolve(null);
  const requestId = ++nativeRequestSequence;
  const pending = new Promise<string | null>((resolve) => {
    nativeRequests.set(requestId, resolve);
    worker.postMessage({ requestId, source } satisfies NativeDiagramRequest);
  });
  nativeResults.set(source, pending);
  return pending;
}

/** Start the diagram worker before it is needed: a fence that is still
 *  streaming will close in a moment, and the layout engine should be warm by
 *  then. Mermaid itself loads only for a diagram the worker cannot draw. */
export function preloadMermaid(): void {
  startNativeWorker();
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
export async function renderMermaid(source: string, isDark: boolean): Promise<MermaidResult> {
  const svg = await drawNatively(source);
  return svg ? { svg } : renderWithMermaid(source, isDark);
}

function renderWithMermaid(source: string, isDark: boolean): Promise<MermaidResult> {
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
      // An error from the frame is the frame's `Error`, not this realm's.
      const message = (error as { message?: unknown } | null)?.message;
      return { error: describeError(typeof message === "string" ? message : String(error)) };
    }
  });
  queue = pending;
  results.set(key, pending);
  return pending;
}
