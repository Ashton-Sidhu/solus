import type { Editor } from '@tiptap/core'
import { columnResizingPluginKey, type Dragging } from '@tiptap/pm/tables'

export interface TableResizePreview {
  x: number
  top: number
  height: number
}

const CELL_MIN_WIDTH = 96

export function resizePreviewX(
  dragging: Dragging,
  clientX: number,
  boundaryX: number,
): number {
  const width = Math.max(
    CELL_MIN_WIDTH,
    dragging.startWidth + clientX - dragging.startX,
  )
  return boundaryX + width - dragging.startWidth
}

function restoreStyle(element: HTMLElement, style: string | null) {
  if (style === null) element.removeAttribute('style')
  else element.setAttribute('style', style)
}

/**
 * Tiptap previews a column drag by rewriting the table's colgroup on every
 * mousemove. Those writes reflow every line in the affected cells before the
 * user has chosen a width. Restore the starting DOM in the same event turn and
 * show a fixed overlay instead; Tiptap still commits its normal document
 * transaction on mouseup, so persistence and undo remain native.
 */
export function deferTableResizeReflow(
  editor: Editor,
  onPreview: (preview: TableResizePreview | null) => void,
): () => void {
  const editorElement = editor.view.dom
  const ownerWindow = editorElement.ownerDocument.defaultView ?? window
  let stopActiveResize: ((restore: boolean) => void) | null = null
  let isDisposed = false

  const begin = (event: MouseEvent) => {
    const target = event.target as Element | null
    const table = target?.closest('table') as HTMLTableElement | null
    if (!table) return

    // ProseMirror owns the mousedown first. Waiting for the microtask means its
    // resize state and window listeners are installed before ours, so our move
    // handler can restore the preview-only DOM after Tiptap mutates it.
    queueMicrotask(() => {
      if (isDisposed) return
      const state = columnResizingPluginKey.getState(editor.state)
      if (!state?.dragging || stopActiveResize) return

      const dragging = state.dragging
      const tableStyle = table.getAttribute('style')
      const columns = Array.from(
        table.querySelectorAll<HTMLTableColElement>('colgroup > col'),
      ).map((column) => ({ column, style: column.getAttribute('style') }))
      const rect = table.getBoundingClientRect()
      const cellRect = target?.closest('td, th')?.getBoundingClientRect()
      const boundaryX = cellRect
        ? Math.abs(event.clientX - cellRect.left) <
          Math.abs(cellRect.right - event.clientX)
          ? cellRect.left
          : cellRect.right
        : event.clientX

      const restoreStartingLayout = () => {
        restoreStyle(table, tableStyle)
        for (const snapshot of columns) {
          restoreStyle(snapshot.column, snapshot.style)
        }
      }

      const stop = (restore: boolean) => {
        if (restore) restoreStartingLayout()
        ownerWindow.removeEventListener('mousemove', move)
        ownerWindow.removeEventListener('mouseup', finish)
        ownerWindow.removeEventListener('blur', cancel)
        onPreview(null)
        if (stopActiveResize === stop) stopActiveResize = null
      }
      const move = (moveEvent: MouseEvent) => {
        // Tiptap treats a buttonless move as the end of the drag and commits
        // before this listener runs. Do not overwrite that final DOM.
        if (!moveEvent.buttons) {
          stop(false)
          return
        }
        restoreStartingLayout()
        onPreview({
          x: resizePreviewX(dragging, moveEvent.clientX, boundaryX),
          top: rect.top,
          height: rect.height,
        })
      }
      const finish = () => stop(false)
      const cancel = () => stop(true)

      stopActiveResize = stop
      onPreview({ x: boundaryX, top: rect.top, height: rect.height })
      ownerWindow.addEventListener('mousemove', move)
      ownerWindow.addEventListener('mouseup', finish)
      ownerWindow.addEventListener('blur', cancel)
    })
  }

  editorElement.addEventListener('mousedown', begin)
  return () => {
    isDisposed = true
    editorElement.removeEventListener('mousedown', begin)
    stopActiveResize?.(true)
  }
}
