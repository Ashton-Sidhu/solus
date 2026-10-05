import { z } from "zod";

/** The content height a sandboxed render reports for itself, so the host can
 *  grow the frame to fit. Posted by the reporter in `lib/artifactSandbox`. */
export const artifactHeightMessageSchema = z.object({
  type: z.literal("solus-artifact-height"),
  h: z.number(),
});

/** The last height each render reported, keyed by its markup. A transcript row
 *  unmounts off screen and remounts on the way back; a frame that restarted
 *  from a guess grew under the reader and made the scroll jump. Bounded so a
 *  long-lived client does not keep every render it ever showed. */
const reportedHeights = new Map<string, number>();
const REPORTED_HEIGHT_LIMIT = 256;

export function lastReportedHeight(html: string): number | undefined {
  return reportedHeights.get(html);
}

export function rememberReportedHeight(html: string, height: number): void {
  reportedHeights.delete(html);
  reportedHeights.set(html, height);
  if (reportedHeights.size > REPORTED_HEIGHT_LIMIT) {
    reportedHeights.delete(reportedHeights.keys().next().value!);
  }
}

/** Whether markup needs the sandbox frame to render faithfully. The rule is
 *  the document model's, because it also decides which ```html fence is a
 *  live block. */
export { needsSandbox } from "@solus/document-model/fences";

/** Uniform zoom that fits the inline render into the expand overlay, leaving a
 *  small margin. 1 when there is nothing measured yet — the iframe then renders
 *  at its inline size rather than collapsing. */
export function expandScale(
  nativeWidth: number,
  contentHeight: number,
  avail: { w: number; h: number },
): number {
  if (nativeWidth <= 0 || contentHeight <= 0 || avail.w <= 0) return 1;
  return Math.min(avail.w / nativeWidth, avail.h / contentHeight) * 0.92;
}
