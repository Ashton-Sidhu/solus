import { mount, unmount } from "svelte";
import type { useSvelteFlow } from "@xyflow/svelte";
import type { NodeSize } from "@solus/contracts/diagram-layout";
import {
  figureRasterRatio,
  fitToPage,
  scrollingFigureRasterRatio,
} from "@solus/contracts/diagram-page";
import DiagramExportStage from "../DiagramExportStage.svelte";
import { dataUrlToPayload, exportFrame, renderDiagramPng } from "./diagram-export";
import { printLayoutCandidates } from "./page-layout";

/** Frames to wait for the stage to mount, and again for it to measure, before giving up. */
const FRAME_BUDGET = 120;

/** Painted behind an off-screen capture: the light board colour the editor uses. */
const STAGE_BACKGROUND = "#fefefc";

type FlowInstance = ReturnType<typeof useSvelteFlow>;

interface MountedStage {
  flow: FlowInstance;
  root: HTMLElement;
}

/** The Svelte contexts the stage inherits — a canvas reads the theme from them. */
export type StageContexts = Map<unknown, unknown>;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Re-run `check` once a frame until it answers, or the budget runs out. */
async function untilFrame<T>(check: () => T | null): Promise<T | null> {
  for (let frame = 0; frame < FRAME_BUDGET; frame += 1) {
    const value = check();
    if (value) return value;
    await nextFrame();
  }
  return null;
}

/**
 * The flow measures nodes with a ResizeObserver after they mount, and the
 * export frames the graph from those measurements. Capturing before they
 * land would frame a graph of zero-size nodes.
 */
function hasMeasuredNodes(flow: FlowInstance): boolean {
  const nodes = flow.getNodes();
  return nodes.length > 0 && nodes.every((node) => node.measured?.width && node.measured?.height);
}

/**
 * Mount an off-screen canvas for `content`, wait until every node is measured,
 * hand it to `use`, and unmount it. Resolves `null` when the diagram has
 * nothing to draw, since then no flow ever mounts.
 */
async function withMountedStage<T>(
  content: string,
  title: string,
  contexts: StageContexts,
  print: boolean,
  use: (stage: MountedStage) => Promise<T>,
): Promise<T | null> {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let ready: MountedStage | null = null;
  const stage = mount(DiagramExportStage, {
    target,
    context: contexts,
    props: {
      content,
      title,
      print,
      onReady: (flow: FlowInstance, root: HTMLElement) => {
        ready = { flow, root };
      },
    },
  });
  try {
    const mounted = await untilFrame(() => ready);
    if (!mounted) return null;
    const measured = await untilFrame(() => (hasMeasuredNodes(mounted.flow) ? mounted : null));
    if (!measured) throw new Error("The diagram did not finish laying out.");
    return await use(measured);
  } finally {
    await unmount(stage);
    target.remove();
  }
}

function base64Of(dataUrl: string | null): string | null {
  return dataUrl ? dataUrlToPayload(dataUrl).contents : null;
}

/** The card sizes the canvas actually rendered, which a re-layout needs to
 *  pack cards tightly without overlapping them. */
function measuredSizes(flow: FlowInstance): Map<string, NodeSize> {
  const sizes = new Map<string, NodeSize>();
  for (const node of flow.getNodes()) {
    const { width, height } = node.measured ?? {};
    if (width && height) sizes.set(node.id, { w: width, h: height });
  }
  return sizes;
}

/** Capture the whole graph as one PNG at `ratio` PNG pixels per CSS pixel. */
async function capture(stage: MountedStage, ratio: number): Promise<string | null> {
  return base64Of(await renderDiagramPng({
    flow: stage.flow,
    root: stage.root,
    backgroundColor: STAGE_BACKGROUND,
    devicePixelRatio: ratio,
  }));
}

/**
 * Render a diagram for a document that scrolls rather than paginates — a
 * Confluence page. There is no page to fit, so the drawing is published
 * exactly as the canvas has it: no re-layout, and the reader opens the
 * full-resolution image to read a big one. Returns `null` for a diagram with
 * nothing to draw.
 */
export function renderDiagramAsAuthored(
  content: string,
  title: string,
  contexts: StageContexts,
): Promise<string | null> {
  return withMountedStage(content, title, contexts, false, (stage) =>
    capture(stage, scrollingFigureRasterRatio(exportFrame(stage.flow))));
}

/**
 * Render a diagram for a page: one picture of the whole graph, drawn as large
 * as the page allows. The canvas the author sees is spaced for panning, so the
 * drawing is always laid out again for print — top-to-bottom and
 * left-to-right, both packed against the card sizes the first mount measured —
 * and whichever the page shows largest is the one captured. The capture ratio
 * follows that page fit rather than the canvas, so a drawing the page enlarges
 * is rasterized larger to match. Returns `null` for a diagram with nothing to
 * draw.
 */
export async function renderDiagramForPage(
  content: string,
  title: string,
  contexts: StageContexts,
): Promise<string | null> {
  // Every mount here is in print type, so the sizes measured are the sizes
  // laid out and the sizes captured.
  const measured = await withMountedStage(content, title, contexts, true, async (stage) => measuredSizes(stage.flow));
  if (!measured) return null;

  // The authored drawing stands only when the content cannot be re-laid out.
  let best = { content, scale: 0 };
  for (const candidate of printLayoutCandidates(content, measured)) {
    const scale = await withMountedStage(candidate, title, contexts, true, async (stage) => fitToPage(exportFrame(stage.flow)));
    if (scale !== null && scale > best.scale) best = { content: candidate, scale };
  }
  return withMountedStage(best.content, title, contexts, true, (stage) =>
    capture(stage, figureRasterRatio(exportFrame(stage.flow))));
}
