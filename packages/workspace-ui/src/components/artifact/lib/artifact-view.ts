import { z } from "zod";

/** The content height a sandboxed render reports for itself, so the host can
 *  grow the frame to fit. Posted by the reporter in `lib/artifactSandbox`. */
export const artifactHeightMessageSchema = z.object({
  type: z.literal("solus-artifact-height"),
  h: z.number(),
});

/** The last height each render reported, filed under a hash of its markup. A
 *  transcript row unmounts off screen and remounts on the way back; a frame
 *  that restarted from a guess grew under the reader and made the scroll jump.
 *  Kept in localStorage, so the first paint after a restart also starts at the
 *  right height. Bounded so a long-lived client does not keep every render it
 *  ever showed. */
const REPORTED_HEIGHTS_KEY = "solus.artifact-heights";
const REPORTED_HEIGHT_LIMIT = 256;
let reportedHeights: Map<string, number> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function storedHeights(): Map<string, number> {
  if (reportedHeights) return reportedHeights;
  reportedHeights = new Map();
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(REPORTED_HEIGHTS_KEY) ?? "[]");
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number") {
          reportedHeights.set(entry[0], entry[1]);
        }
      }
    }
  } catch {
    // Unreadable storage only costs the first paint its height.
  }
  return reportedHeights;
}

/** One write per burst: a render that resizes reports several heights in a row. */
function saveHeightsSoon(): void {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      globalThis.localStorage?.setItem(REPORTED_HEIGHTS_KEY, JSON.stringify([...storedHeights()]));
    } catch {
      // Storage full or blocked: the heights still hold for this run.
    }
  }, 1000);
}

/** FNV-1a and the length: markup can be megabytes, and storage wants a short key.
 *  A collision only costs one render its first-paint height. */
function heightKeyOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}:${text.length.toString(36)}`;
}

export function lastReportedHeight(html: string): number | undefined {
  return storedHeights().get(heightKeyOf(html));
}

export function rememberReportedHeight(html: string, height: number): void {
  const heights = storedHeights();
  const key = heightKeyOf(html);
  const isUnchanged = heights.get(key) === height;
  // Re-inserting marks the render recently shown, so eviction takes the oldest.
  heights.delete(key);
  heights.set(key, height);
  if (heights.size > REPORTED_HEIGHT_LIMIT) {
    heights.delete(heights.keys().next().value!);
  }
  if (!isUnchanged) saveHeightsSoon();
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
