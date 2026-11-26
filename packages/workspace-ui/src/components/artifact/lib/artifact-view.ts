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
 *  A collision only costs one render its first-paint height. The same key
 *  remembers the reader's width choice for a render in a conversation. */
export function renderKeyOf(text: string): string {
  // A frame asks again on every height it reports. The same string object
  // hashes once: the map lookup reuses the hash the engine keeps on the string.
  const known = hashedKeys.get(text);
  if (known !== undefined) return known;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const key = `${(hash >>> 0).toString(36)}:${text.length.toString(36)}`;
  hashedKeys.set(text, key);
  if (hashedKeys.size > HASHED_KEY_LIMIT) hashedKeys.delete(hashedKeys.keys().next().value!);
  return key;
}

const HASHED_KEY_LIMIT = 64;
const hashedKeys = new Map<string, string>();

export function lastReportedHeight(html: string): number | undefined {
  return storedHeights().get(renderKeyOf(html));
}

export function rememberReportedHeight(html: string, height: number): void {
  const heights = storedHeights();
  const key = renderKeyOf(html);
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

/** Frames with no height yet: this browser remembered none for their markup,
 *  and they have not reported one. Such a frame grows when it reports. */
const framesWithoutHeight = new Set<Element>();

/** Count a frame as having no height until the returned release runs. */
export function holdFrameHeight(frame: Element): () => void {
  framesWithoutHeight.add(frame);
  return () => framesWithoutHeight.delete(frame);
}

function hasFrameWithoutHeightIn(scroll: Element): boolean {
  if (framesWithoutHeight.size === 0) return false;
  const view = scroll.getBoundingClientRect();
  for (const frame of framesWithoutHeight) {
    if (!scroll.contains(frame)) continue;
    const box = frame.getBoundingClientRect();
    if (box.bottom > view.top && box.top < view.bottom) return true;
  }
  return false;
}

/** The longest a reveal waits for the frames in view to report a height. A
 *  frame whose render never reports must not hold the conversation. */
const FRAME_HEIGHT_WAIT_MS = 300;

/** Wait until the frames in view of `scroll` have a height, so they do not
 *  grow and move the rows after the reader sees them. Answers whether it
 *  waited: the frames that reported moved what is in view. */
export async function waitForFrameHeightsIn(scroll: Element, isCancelled: () => boolean): Promise<boolean> {
  if (!hasFrameWithoutHeightIn(scroll)) return false;
  const deadline = performance.now() + FRAME_HEIGHT_WAIT_MS;
  while (!isCancelled() && performance.now() < deadline && hasFrameWithoutHeightIn(scroll)) {
    await new Promise(requestAnimationFrame);
  }
  return true;
}

/** Heights a host stored for one render, by frame width, and where to send a
 *  height this frame measured. */
export interface StoredFrameSizes {
  heights: readonly (readonly [width: number, height: number])[];
  report?: (width: number, height: number) => void;
}

/** Two frame widths this close lay a render out the same way (the host keeps
 *  one height for them too). */
const SAME_FRAME_WIDTH_PX = 4;

/** The stored height of a render at this frame width. A height measured at
 *  another width belongs to another layout, so it is not used. */
export function storedHeightAt(heights: StoredFrameSizes["heights"] | undefined, width: number): number | undefined {
  if (!heights || width <= 0) return undefined;
  let best: readonly [number, number] | undefined;
  for (const entry of heights) {
    const distance = Math.abs(entry[0] - width);
    if (distance <= SAME_FRAME_WIDTH_PX && (!best || distance < Math.abs(best[0] - width))) best = entry;
  }
  return best?.[1];
}

/** A render reports several heights while it lays out; the one it rests on is sent. */
const FRAME_HEIGHT_SETTLE_MS = 1000;

/**
 * Sends the height a frame rests on, at a width whose stored height differs,
 * once per width. Every later open, on any client, then sizes the frame before
 * it loads. A failed send is dropped: the frame still corrects itself.
 */
export function frameHeightReporter(
  stored: StoredFrameSizes["heights"],
  send: (width: number, height: number) => Promise<void>,
): (width: number, height: number) => void {
  const sent = new Map<number, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (width, height) => {
    const measured = { width: Math.round(width), height: Math.round(height) };
    clearTimeout(timer);
    timer = setTimeout(() => {
      const known = sent.get(measured.width) ?? storedHeightAt(stored, measured.width);
      if (known !== undefined && Math.abs(known - measured.height) <= 1) return;
      sent.set(measured.width, measured.height);
      void send(measured.width, measured.height).catch(() => {});
    }, FRAME_HEIGHT_SETTLE_MS);
  };
}
