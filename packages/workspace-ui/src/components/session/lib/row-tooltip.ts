import type { Attachment } from "svelte/attachments";

/** The open state of one sidebar row's tooltip. */
export interface RowTooltip {
  isOpen: () => boolean;
  /** The sidebar keeps row tooltips shut (a click reordered the list, or Settings covers it). */
  isQuiet: () => boolean;
  close: () => void;
}

/**
 * Closes a row's open tooltip when the pointer is not on the row.
 *
 * bits-ui closes a tooltip on the trigger's `pointerleave`. When the sidebar
 * list changes order, it moves row nodes in the DOM, and the browser sends no
 * `pointerleave` to a node that it moved from under the pointer. Without this
 * attachment, the tooltip stays on screen after the pointer has gone.
 *
 * bits-ui also keeps an open tooltip open when its root becomes disabled, so
 * a row that goes quiet closes its tooltip here.
 */
export function closesRowTooltip(tooltip: RowTooltip): Attachment<HTMLElement> {
  return (row) => {
    if (!tooltip.isOpen()) return;
    if (tooltip.isQuiet()) {
      tooltip.close();
      return;
    }
    const closeWhenElsewhere = (event: PointerEvent) => {
      if (!(event.target instanceof Node && row.contains(event.target))) tooltip.close();
    };
    window.addEventListener("pointermove", closeWhenElsewhere, { passive: true });
    return () => window.removeEventListener("pointermove", closeWhenElsewhere);
  };
}
