import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/svelte";
import { toPng, toSvg } from "html-to-image";

/** `html-to-image` keeps its options type internal; take it from the call. */
type EncodeOptions = NonNullable<Parameters<typeof toPng>[1]>;

/** Padding (px) added around the graph bounds when framing an image export. */
const EXPORT_PADDING = 80;
/** Floor on an exported image's dimensions, so a tiny graph still renders usably. */
const EXPORT_MIN_WIDTH = 240;
const EXPORT_MIN_HEIGHT = 180;

/** The slice of the flow instance an image export needs — the graph's extent. */
export interface DiagramExportFlow {
  getNodes: () => Node[];
}

export interface RenderDiagramImageOptions {
  flow: DiagramExportFlow;
  /** Painted behind the graph; omitted for SVG, which exports transparent. */
  backgroundColor?: string;
  /**
   * Lets the shell mount every node before the capture (large graphs virtualize)
   * and returns the teardown to run once the bytes are encoded.
   */
  prepare?: () => Promise<() => void>;
}

/**
 * Frame the whole graph and render the viewport element to an image. The
 * viewport holds only nodes and edges, so minimap, controls and background
 * chrome are naturally excluded from the capture.
 *
 * Returns `null` when there is nothing to export.
 */
async function renderViewport(
  encode: (el: HTMLElement, opts: EncodeOptions) => Promise<string>,
  { flow, backgroundColor, prepare }: RenderDiagramImageOptions,
): Promise<string | null> {
  const nodes = flow.getNodes();
  if (!nodes.length) return null;
  const finish = await prepare?.();
  try {
    const el = document.querySelector<HTMLElement>(".svelte-flow__viewport");
    if (!el) return null;

    const bounds = getNodesBounds(nodes);
    const imageWidth = Math.max(Math.round(bounds.width) + EXPORT_PADDING, EXPORT_MIN_WIDTH);
    const imageHeight = Math.max(Math.round(bounds.height) + EXPORT_PADDING, EXPORT_MIN_HEIGHT);
    const viewport = getViewportForBounds(bounds, imageWidth, imageHeight, 0.2, 2.5, 0.12);

    return await encode(el, {
      backgroundColor,
      width: imageWidth,
      height: imageHeight,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    });
  } finally {
    finish?.();
  }
}

export function renderDiagramPng(options: RenderDiagramImageOptions): Promise<string | null> {
  return renderViewport(toPng, options);
}

/** SVG exports transparent: it is placed onto a surface whose colour is not ours. */
export function renderDiagramSvg(options: RenderDiagramImageOptions): Promise<string | null> {
  return renderViewport(toSvg, { ...options, backgroundColor: undefined });
}

/** How a payload rides the string-typed `writeFile` contract. */
export interface FilePayload {
  contents: string;
  encoding: "utf8" | "base64";
}

/**
 * `html-to-image` returns base64 for PNG but percent-encoded text for SVG, so a
 * caller that wants bytes has to read the data URL's own encoding rather than
 * assume one.
 */
export function dataUrlToPayload(dataUrl: string): FilePayload {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return { contents: dataUrl, encoding: "utf8" };
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (meta.endsWith(";base64")) return { contents: body, encoding: "base64" };
  return { contents: decodeURIComponent(body), encoding: "utf8" };
}
