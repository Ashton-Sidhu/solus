import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { PlanComment } from "../../../shared/types";

/**
 * True when the editor's current selection was made by the user's cursor — a
 * mouse drag or keyboard selection — rather than a programmatic
 * `setTextSelection` (find/replace, comment-mark restore, agent rewrites).
 *
 * ProseMirror stamps every selection it derives from a real DOM event with an
 * origin ("pointer" | "key") and a timestamp; programmatic selections leave
 * both stale. We read that stamp directly (it's what PM itself consults — see
 * `readDOMChange`) within a short recency window, so the floating "Comment"
 * affordance only fires for intentional selections. Consult it at the top of a
 * `selectionUpdate` handler.
 */
export function isUserSelection(editor: Editor): boolean {
  // `input` is ProseMirror's internal InputState — not in the public typings.
  const { input } = editor.view as unknown as {
    input: { lastSelectionOrigin: string | null; lastSelectionTime: number };
  };
  const origin = input?.lastSelectionOrigin;
  if (origin !== "pointer" && origin !== "key") return false;
  return Date.now() - input.lastSelectionTime < 100;
}

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
  return scrollContainer.querySelector(
    `mark[data-plan-comment="${commentId}"]`,
  ) as HTMLElement | null;
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

export function scrollAndFlashMark(
  scrollContainer: HTMLDivElement,
  mark: HTMLElement,
): void {
  const containerTop = scrollContainer.getBoundingClientRect().top;
  const markTop = mark.getBoundingClientRect().top;
  scrollContainer.scrollBy({
    top: markTop - containerTop - 80,
    behavior: "smooth",
  });
  flashMark(mark);
}

export function resolveHoveredComment(
  e: MouseEvent,
  comments: PlanComment[],
): { comment: PlanComment; anchor: { x: number; y: number } } | null {
  const mark = (e.target as HTMLElement).closest(
    "mark[data-plan-comment]",
  ) as HTMLElement | null;
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
      tr.addMark(
        from,
        to,
        markType.create({ commentId: c.id, type: "saved" }),
      );
    }
  }
  if (!tr.docChanged) return false;

  editor.view.dispatch(tr);
  return true;
}
