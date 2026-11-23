/**
 * A reference chip selects as one word: a selection never ends inside it.
 *
 * A chip shows a short label, and its copy-only text carries the whole link
 * (`linkChipCopyParts`). A selection that ended part way into the chip copied
 * half a link (`see [fo`). So when an end of a selection falls inside a chip,
 * this moves it to the chip's edge: the end that grows the selection takes the
 * whole chip, and the end that shrinks it leaves the whole chip out.
 *
 * Editors are out of scope. CodeMirror and ProseMirror keep their own
 * selection and already treat a chip as one atom.
 */

/** Where a point sits relative to a chip: before it, inside it, or after it. */
export type ChipSide = -1 | 0 | 1;

/** The chip edge a selection end moves to. */
export type ChipEdge = "before" | "after";

/**
 * The edge for the anchor when it is inside a chip: the edge away from the
 * focus, so the chip stays in the selection. `focusSide` is where the focus is
 * relative to the anchor's chip.
 */
export function anchorEdge(focusSide: ChipSide): ChipEdge {
  return focusSide < 0 ? "after" : "before";
}

/**
 * The edge for the focus when it is inside a chip that does not hold the
 * anchor. A pointer that reaches a chip takes it in. A key that moves the focus
 * into a chip steps over it, so a selection can grow and shrink one chip at a
 * time from the keyboard. `previousSide` is where the focus was before the key.
 */
export function focusEdge(anchorSide: ChipSide, previousSide: ChipSide | null, byPointer: boolean): ChipEdge {
  if (!byPointer && previousSide !== null && previousSide !== 0) return previousSide < 0 ? "after" : "before";
  return anchorSide < 0 ? "after" : "before";
}

interface SelectionPoint {
  node: Node;
  offset: number;
}

function chipAt(node: Node | null): Element | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  const chip = element?.closest(".solus-token") ?? null;
  return chip?.parentElement?.isContentEditable ? null : chip;
}

function sideOf(chip: Element, point: SelectionPoint): ChipSide {
  const range = chip.ownerDocument.createRange();
  range.selectNode(chip);
  const order = range.comparePoint(point.node, point.offset);
  if (order < 0) return -1;
  if (order > 0) return 1;
  // The range holds its own edges, but a point on an edge is outside the chip.
  if (point.node === range.startContainer && point.offset === range.startOffset) return -1;
  if (point.node === range.endContainer && point.offset === range.endOffset) return 1;
  return 0;
}

function edgePoint(chip: Element, edge: ChipEdge): SelectionPoint {
  const range = chip.ownerDocument.createRange();
  if (edge === "before") range.setStartBefore(chip);
  else range.setStartAfter(chip);
  return { node: range.startContainer, offset: range.startOffset };
}

const SELECTED_CLASS = "solus-token--selected";

let isInstalled = false;

/** Snap selections to whole chips in this document. Safe to call many times. */
export function installChipSelection(): void {
  // A server render of a transcript has no document and no selection.
  if (isInstalled || !("document" in globalThis)) return;
  isInstalled = true;

  // The chip a pointer drag started on. Its anchor is moved to an edge on the
  // first change, so the chip is no longer found from the anchor itself; it is
  // kept here so the anchor can move to the other edge when the drag turns.
  let pressedChip: Element | null = null;
  let isPointerDown = false;
  let previousFocus: SelectionPoint | null = null;

  document.addEventListener("pointerdown", (event) => {
    isPointerDown = true;
    pressedChip = event.target instanceof Node ? chipAt(event.target) : null;
  }, true);
  const release = () => {
    isPointerDown = false;
    pressedChip = null;
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  // A double-click selects the chip, as it selects a word. The browser's word
  // selection does this for a label it can select; this covers one it cannot.
  document.addEventListener("dblclick", (event) => {
    const chip = event.target instanceof Node ? chipAt(event.target) : null;
    if (!chip) return;
    const start = edgePoint(chip, "before");
    const end = edgePoint(chip, "after");
    document.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  });

  // The chips inside the selection, marked so each paints the highlight. A
  // chip's glyph is not text, so the selection's own paint left a gap at it.
  const markedChips = new Set<Element>();

  function markSelectedChips(selection: Selection): void {
    const range = !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const common = range?.commonAncestorContainer ?? null;
    // A selection inside an SVG glyph has a container with no editing state;
    // its nearest HTML ancestor answers for it.
    const container = (common instanceof Element ? common : common?.parentElement)?.closest(":not(svg, svg *)") ?? null;
    const selectedChips = new Set<Element>();
    if (range && container instanceof HTMLElement && !container.isContentEditable) {
      const ownChip = container.closest(".solus-token");
      if (ownChip) selectedChips.add(ownChip);
      for (const chip of container.querySelectorAll(".solus-token")) {
        if (range.intersectsNode(chip)) selectedChips.add(chip);
      }
    }
    for (const chip of markedChips) {
      if (selectedChips.has(chip)) continue;
      chip.classList.remove(SELECTED_CLASS);
      markedChips.delete(chip);
    }
    for (const chip of selectedChips) {
      if (markedChips.has(chip)) continue;
      chip.classList.add(SELECTED_CLASS);
      markedChips.add(chip);
    }
  }

  /** Moves a selection end out of a chip. True when the selection changed. */
  function snapToChips(selection: Selection, lastFocus: SelectionPoint | null): boolean {
    if (!selection.anchorNode || !selection.focusNode) return false;
    let anchor: SelectionPoint = { node: selection.anchorNode, offset: selection.anchorOffset };
    let focus: SelectionPoint = { node: selection.focusNode, offset: selection.focusOffset };
    // A drag that started on a chip keeps the chip, even when the focus comes
    // back to the edge the anchor was moved to.
    if (selection.isCollapsed && !pressedChip) return false;

    const anchorChip = chipAt(anchor.node) ?? pressedChip;
    const focusChip = chipAt(focus.node);
    if (!anchorChip && !focusChip) return false;

    if (anchorChip && anchorChip === focusChip) {
      anchor = edgePoint(anchorChip, "before");
      focus = edgePoint(anchorChip, "after");
    } else {
      if (anchorChip) anchor = edgePoint(anchorChip, anchorEdge(sideOf(anchorChip, focus)));
      if (focusChip) {
        const previousSide = lastFocus ? sideOf(focusChip, lastFocus) : null;
        focus = edgePoint(focusChip, focusEdge(sideOf(focusChip, anchor), previousSide, isPointerDown));
      }
    }
    previousFocus = focus;
    if (
      anchor.node === selection.anchorNode && anchor.offset === selection.anchorOffset &&
      focus.node === selection.focusNode && focus.offset === selection.focusOffset
    ) return false;
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    return true;
  }

  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection) return;
    const lastFocus = previousFocus;
    previousFocus = selection.focusNode ? { node: selection.focusNode, offset: selection.focusOffset } : null;
    // A changed selection fires this again, and that pass marks the chips.
    if (snapToChips(selection, lastFocus)) return;
    markSelectedChips(selection);
  });
}
