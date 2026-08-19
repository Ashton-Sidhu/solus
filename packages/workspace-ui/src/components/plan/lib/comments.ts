import type { Editor } from "@tiptap/core";
import type { PlanComment } from "@solus/contracts/types";

type ProseMirrorNode = Editor["state"]["doc"];

export function prosePosToTextOffset(
  editor: Editor,
  prosePos: number,
): number {
  // Offset into the same flattened text model `restoreCommentMarks` searches
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

export function findMarkElement(
  scrollContainer: HTMLDivElement | null,
  commentId: string,
): HTMLElement | null {
  if (!scrollContainer) return null;
  return scrollContainer.querySelector<HTMLElement>(
    `mark[data-plan-comment="${commentId}"]`,
  );
}

export function addCommentMark(
  editor: Editor,
  from: number,
  to: number,
  commentId: string,
): void {
  const markType = editor.schema.marks.planComment;
  const tr = editor.state.tr;
  tr.setMeta("addToHistory", false);
  // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
  tr.addMark(from, to, markType.create({ commentId, type: "saved" }));
  editor.view.dispatch(tr);
}

export function removeCommentMark(editor: Editor, commentId: string): void {
  const markType = editor.schema.marks.planComment;
  if (!markType) return;
  const { doc, tr } = editor.state;
  tr.setMeta("addToHistory", false);
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const hasMark = node.marks.some(
      (m) => m.type === markType && m.attrs.commentId === commentId,
    );
    // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
    if (hasMark) tr.removeMark(pos, pos + node.nodeSize, markType);
  });
  editor.view.dispatch(tr);
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

/**
 * The mark state a thread should be wearing. Every annotation state has to
 * stay legible with the rail hidden, so the mark carries the thread's state
 * rather than merely its existence: a resolved thread keeps a dotted sage
 * trace, one Solus wrote is dashed terracotta.
 */
export function markTypeFor(comment: PlanComment): string {
  if (comment.resolvedAt) return "resolved";
  if (comment.author === "solus") return "solus";
  return "saved";
}

export function restoreCommentMarks(
  editor: Editor,
  comments: PlanComment[],
): boolean {
  const doc = editor.state.doc;
  const markType = editor.schema.marks.planComment;
  if (!markType) return false;

  const tr = editor.state.tr;
  tr.setMeta("addToHistory", false);
  const fullText = doc.textBetween(0, doc.content.size, " ");
  for (const c of comments) {
    const nearOffset = c.textOffset ?? 0;
    let idx = fullText.indexOf(c.selectedText, Math.max(0, nearOffset - 50));
    if (idx === -1) idx = fullText.indexOf(c.selectedText);
    if (idx === -1) continue;

    const from = textBetweenIdxToPos(doc, idx);
    const to = textBetweenIdxToPos(doc, idx + c.selectedText.length);

    if (from !== -1 && to !== -1) {
      // addMark replaces any existing planComment mark over the range, so a
      // thread that has just been resolved re-renders in its new state here
      // rather than needing a separate mark mutation.
      tr.addMark(
        from,
        to,
        // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
        markType.create({ commentId: c.id, type: markTypeFor(c) }),
      );
    }
  }
  if (!tr.docChanged) return false;

  editor.view.dispatch(tr);
  return true;
}
