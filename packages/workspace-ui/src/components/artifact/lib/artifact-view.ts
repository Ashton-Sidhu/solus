import { z } from "zod";

/** The content height a sandboxed render reports for itself, so the host can
 *  grow the frame to fit. Posted by the reporter in `lib/artifactSandbox`. */
export const artifactHeightMessageSchema = z.object({
  type: z.literal("solus-artifact-height"),
  h: z.number(),
});

/** Markup that only renders faithfully inside the sandbox frame: it carries its
 *  own stylesheet, its own behaviour, a vector canvas, or a whole document. The
 *  frame is the one place `<style>` and `<script>` run.
 *
 *  Plain markup — a table, a details block, a div with inline styles — reads
 *  better in the host DOM under the app's prose styles, so it stays there. This
 *  is a fidelity test, not a safety one. */
const SANDBOX_MARKERS = /<(?:style|script|link|svg|canvas)[\s/>]|<!doctype|<html[\s>]/i;

export function needsSandbox(html: string): boolean {
  return SANDBOX_MARKERS.test(html);
}

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
