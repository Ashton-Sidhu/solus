import type { Editor } from "@tiptap/core";
import type { PlanComment } from "@solus/contracts/types";

type ProseMirrorNode = Editor["state"]["doc"];

export function prosePosToTextOffset(
  editor: Editor,
  prosePos: number,
): number {
  // Offset into the same flattened text model a highlight's quote is found in
  // (blocks joined by a single space). PM's `textBetween` already produces it.
  return editor.state.doc.textBetween(0, prosePos, " ").length;
}

export function textBetweenIdxToPos(
  doc: ProseMirrorNode,
  targetIdx: number,
): number {
  let charIdx = 0;
  let firstBlock = true;
  let result = -1;
  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (result !== -1) return false;
    if (node.isBlock && node.isTextblock) {
      if (!firstBlock) {
        if (charIdx === targetIdx) {
          result = pos + 1;
          return false;
        }
        charIdx++;
      }
      firstBlock = false;
    }
    if (node.isText) {
      const len = node.text!.length;
      if (charIdx + len >= targetIdx) {
        result = pos + (targetIdx - charIdx);
        return false;
      }
      charIdx += len;
    }
  });
  if (result === -1 && charIdx === targetIdx) {
    result = doc.content.size;
  }
  return result;
}

/**
 * Every element of a thread's highlight. Local and external highlights are
 * both decorations, split at every node boundary they cross, so a thread can
 * own several.
 */
export function findMarkElements(
  scrollContainer: HTMLDivElement | null,
  commentId: string,
): HTMLElement[] {
  if (!scrollContainer) return [];
  return [
    ...scrollContainer.querySelectorAll<HTMLElement>(
      `mark[data-plan-comment="${commentId}"], [data-external-comment="${commentId}"]`,
    ),
  ];
}

/** The opening element of a thread's highlight — the line its card sits on. */
export function findMarkElement(
  scrollContainer: HTMLDivElement | null,
  commentId: string,
): HTMLElement | null {
  return findMarkElements(scrollContainer, commentId)[0] ?? null;
}

/** Briefly pulse a comment mark to draw the eye to it. */
export function flashMark(mark: HTMLElement): void {
  mark.classList.remove("plan-comment-flash");
  void mark.offsetWidth;
  mark.classList.add("plan-comment-flash");
  setTimeout(() => mark.classList.remove("plan-comment-flash"), 800);
}

/** The document's own scroll curve: 240ms of ease-out, short enough to read as
 *  a jump and long enough to say which way the page went. `behavior: "smooth"`
 *  is the browser's duration, which is neither. */
const SCROLL_MS = 240;

function animateScrollBy(el: HTMLElement, delta: number): void {
  if (Math.abs(delta) < 1) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    el.scrollTop += delta;
    return;
  }
  const from = el.scrollTop;
  const start = performance.now();
  const step = (at: number) => {
    const t = Math.min(1, (at - start) / SCROLL_MS);
    el.scrollTop = from + delta * (1 - Math.pow(1 - t, 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Bring a mark to a third of the reading viewport — not to the top, where the
 * line you were sent to has nothing above it to read it in context.
 */
export function scrollAndFlashMark(
  scrollContainer: HTMLDivElement,
  mark: HTMLElement,
): void {
  const container = scrollContainer.getBoundingClientRect();
  const markTop = mark.getBoundingClientRect().top;
  animateScrollBy(scrollContainer, markTop - container.top - container.height / 3);
  flashMark(mark);
}

export interface HoveredComment {
  comment: PlanComment
  anchor: { x: number; y: number }
}

export function resolveHoveredComment(
  e: MouseEvent,
  comments: PlanComment[],
): HoveredComment | null {
  if (!(e.target instanceof Element)) return null;
  const candidate = e.target.closest("mark[data-plan-comment]");
  const mark = candidate instanceof HTMLElement ? candidate : null;
  if (!mark) return null;
  const commentId = mark.getAttribute("data-plan-comment");
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return null;
  const rect = mark.getBoundingClientRect();
  return {
    comment,
    anchor: { x: rect.left + rect.width / 2, y: rect.bottom + 6 },
  };
}
