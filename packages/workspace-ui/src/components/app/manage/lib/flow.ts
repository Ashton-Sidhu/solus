import type { Edge } from '@xyflow/svelte'

/**
 * What the two node diagrams of the Manage page share (docs/plans/apps.md
 * §9.2): the run graph of Workflows and the flow of Signals. Both are
 * read-only Svelte Flow canvases; an edge is a bezier curve, and a dashed
 * edge leads to a node that nothing reaches now.
 */

/** A curve from `source` to `target`. A dashed one is lighter, and never moves. */
export function flowEdge(source: string, target: string, isDashed: boolean): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: 'default',
    selectable: false,
    focusable: false,
    style: isDashed ? 'stroke: var(--hairline-strongest); stroke-dasharray: 4 5;' : undefined,
  }
}

/**
 * Whether a touch that starts on the canvas belongs to it. On a touch device
 * (`pointer: coarse`) one finger scrolls the page past the canvas, and two
 * fingers pan and pinch it; elsewhere the canvas takes every drag, as with a
 * mouse. Svelte Flow cannot tell the two apart (its `panOnDrag` takes or
 * refuses every touch), so the canvas stops the one-finger touches itself.
 */
export function canvasTakesTouch(touchCount: number, isTouchDevice: boolean): boolean {
  return !isTouchDevice || touchCount >= 2
}
