import type { Editor } from "@tiptap/core";

/** Viewport rect the bubble anchors above. */
export function selectionRect(editor: Editor): DOMRect | null {
  const editorSelection = editor.state.selection;
  if (
    editorSelection.empty ||
    editorSelection.toJSON().type !== "text" ||
    !editorSelection.$from.sameParent(editorSelection.$to)
  ) {
    return null;
  }

  // The DOM range gives the true union rect, so a selection spanning several
  // lines anchors over its own centre rather than over the midpoint between
  // its first and last character (which can land outside the selection).
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return rect;
  }

  // Fallback for selections ProseMirror holds but the DOM doesn't reflect
  // (node selections — an image, a whole table).
  const { from, to } = editorSelection;
  try {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const top = Math.min(start.top, end.top);
    return new DOMRect(
      left,
      top,
      Math.max(start.right, end.right) - left,
      Math.max(start.bottom, end.bottom) - top,
    );
  } catch {
    // coordsAtPos throws on a position that no longer exists in the doc.
    return null;
  }
}

/** Horizontal centre, clamped so the bubble can't run off either edge. */
export function clampedCentre(rect: DOMRect, bubbleWidth: number): number {
  const margin = 12;
  const half = bubbleWidth / 2;
  return Math.min(
    Math.max(rect.left + rect.width / 2, half + margin),
    window.innerWidth - half - margin,
  );
}
