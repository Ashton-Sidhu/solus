import type { ResourceRole } from '@solus/contracts/sharing'

/**
 * Why a shared diagram opens with a read-only canvas, or null when the reader
 * may edit it. A viewer and a commenter get the whole shell (header, History,
 * Review, comments) over a canvas they cannot change: the host refuses their
 * saves, so the canvas must not offer the edit. The wording matches the
 * document surface's.
 */
export function diagramReadOnlyReason(role: ResourceRole | null): string | null {
  if (role === 'commenter') return 'Shared with you to comment and review.'
  if (role === 'viewer') return 'Shared with you to view.'
  return null
}

/** The card callbacks that change the diagram. */
const EDIT_HANDLERS = [
  'onLabelChange',
  'onResize',
  'onResizeLive',
  'onToggleCollapse',
  'onLabelOffsetChange',
  'onLabelOffsetCommit',
  'onBendOffsetChange',
  'onBendOffsetCommit',
] as const

/**
 * A reader's node or edge callbacks: the editor's, less every one that changes
 * the diagram. The cards offer an edit only when its handler is present, so an
 * absent one hides label editing, the fold toggle and the edge grips;
 * `resizable: false` hides the resize frame.
 */
export function readingHandlers<T extends object>(handlers: T): Partial<T> & { resizable: false } {
  const reading: Partial<T> = { ...handlers }
  for (const key of EDIT_HANDLERS) delete reading[key as keyof T]
  return { ...reading, resizable: false }
}
