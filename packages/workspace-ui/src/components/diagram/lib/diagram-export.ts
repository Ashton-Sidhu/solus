import type { useSvelteFlow } from "@xyflow/svelte";
import { toPng, toSvg } from "html-to-image";
import type { PixelSize } from "@solus/contracts/diagram-page";

/** `html-to-image` keeps its options type internal; take it from the call. */
type EncodeOptions = NonNullable<Parameters<typeof toPng>[1]>;

/** Padding (px) added around the graph bounds when framing an image export. */
const EXPORT_PADDING = 80;
/** Floor on an exported image's dimensions, so a tiny graph still renders usably. */
const EXPORT_MIN_WIDTH = 240;
const EXPORT_MIN_HEIGHT = 180;
/**
 * Never rasterize below 2×: a 1× display would otherwise write a PNG that is
 * soft the moment it is zoomed or placed on a page, and the cost is one
 * larger canvas for the duration of the export.
 */
const EXPORT_MIN_PIXEL_RATIO = 2;
/**
 * Ceiling on the rasterized pixel count. Google Docs refuses an inline image
 * over 25 megapixels — a live publish met that error — so this stays a clear
 * margin below it. The staging upload is resumable, so bytes are not the
 * bound; this is.
 */
const EXPORT_MAX_PIXELS = 20_000_000;

/**
 * The scale to rasterize a `width`×`height` frame at: at least 2×, the display's
 * own ratio if higher, and lower than either when a large graph would
 * otherwise exceed the pixel ceiling.
 */
export function exportPixelRatio(width: number, height: number, devicePixelRatio: number): number {
  const wanted = Math.max(EXPORT_MIN_PIXEL_RATIO, devicePixelRatio || 1);
  return Math.min(wanted, Math.sqrt(EXPORT_MAX_PIXELS / (width * height)));
}

/** The slice of the flow instance an image export needs — the graph's extent. */
export type DiagramExportFlow = Pick<
  ReturnType<typeof useSvelteFlow>,
  "getNodes" | "getNodesBounds"
>;

export interface RenderDiagramImageOptions {
  flow: DiagramExportFlow;
  /**
   * The element that holds this canvas. Every tab stays mounted, so the
   * viewport is found inside it rather than as the first one in the document.
   */
  root: HTMLElement;
  /** Painted behind the graph; omitted for SVG, which exports transparent. */
  backgroundColor?: string;
  /** The display ratio to rasterize for; the window's own when omitted. */
  devicePixelRatio?: number;
  /**
   * Lets the shell mount every node before the capture (large graphs virtualize)
   * and returns the teardown to run once the bytes are encoded.
   */
  prepare?: () => Promise<() => void>;
}

function frameForBounds(bounds: PixelSize): PixelSize {
  return {
    width: Math.max(Math.round(bounds.width) + EXPORT_PADDING, EXPORT_MIN_WIDTH),
    height: Math.max(Math.round(bounds.height) + EXPORT_PADDING, EXPORT_MIN_HEIGHT),
  };
}

/** The image frame, in CSS pixels, that an export of this flow fills. */
export function exportFrame(flow: DiagramExportFlow): PixelSize {
  return frameForBounds(flow.getNodesBounds(flow.getNodes()));
}

/**
 * Frame the whole graph and render the viewport element to an image. The
 * viewport holds only nodes and edges, so minimap, controls and background
 * chrome are naturally excluded from the capture.
 *
 * `pixelRatio` carries the resolution. `html-to-image` wraps the element in an
 * SVG at its CSS size and draws that onto a canvas `pixelRatio` times larger;
 * Chromium re-rasterizes the SVG at the size it is drawn, so the glyphs are
 * painted at the final resolution rather than enlarged. Measured: scaling the
 * drawing instead, and taking the image at 1:1, produces an identical PNG.
 *
 * Returns `null` when there is nothing to export.
 */
async function renderViewport(
  encode: (el: HTMLElement, opts: EncodeOptions) => Promise<string>,
  { flow, root, backgroundColor, devicePixelRatio, prepare }: RenderDiagramImageOptions,
): Promise<string | null> {
  const nodes = flow.getNodes();
  if (!nodes.length) return null;
  const finish = await prepare?.();
  try {
    const el = root.querySelector<HTMLElement>(".svelte-flow__viewport");
    if (!el) return null;

    const bounds = flow.getNodesBounds(nodes);
    const { width: imageWidth, height: imageHeight } = frameForBounds(bounds);
    // One margin, stated once. The frame is already the graph plus
    // EXPORT_PADDING, so the graph is drawn at 1:1 and centred in it;
    // `getViewportForBounds` would inset a further 12% of the frame, which on
    // a page figure is 12% of the reader's diagram spent on white.
    const x = (imageWidth - bounds.width) / 2 - bounds.x;
    const y = (imageHeight - bounds.height) / 2 - bounds.y;

    return await encode(el, {
      backgroundColor,
      pixelRatio: exportPixelRatio(imageWidth, imageHeight, devicePixelRatio ?? window.devicePixelRatio),
      width: imageWidth,
      height: imageHeight,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${x}px, ${y}px)`,
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
