import type { Editor } from '@tiptap/core'
import { columnResizingPluginKey, TableMap } from '@tiptap/pm/tables'
import { DRAG_SETTLE_MS } from './table-drag'
import { columnSnapCandidates, snappedClientX } from './table-resize-snap'

/**
 * Column resizing that follows the pointer.
 *
 * The border a reader drags is not a preview that commits on release: the
 * column takes the width under the pointer on every frame, the text reflows in
 * it, and the neighbour absorbs the delta. ProseMirror already does exactly
 * that, so this adds only the two things it does not: the drag settles onto an
 * equal share or a content fit when it passes within a few pixels of one, and a
 * double-click on the border fits the column to its content outright.
 *
 * The snap is expressed as the pointer position that would have produced it, so
 * the resize plugin remains the only thing that writes a width — persistence,
 * undo and the neighbour's delta all stay native.
 */

/** Which of a cell's two vertical borders the pointer grabbed. */
function grabbedColumnIndex(cell: HTMLTableCellElement, clientX: number): number {
  const rect = cell.getBoundingClientRect()
  const grabbedRight = Math.abs(rect.right - clientX) <= Math.abs(clientX - rect.left)
  return grabbedRight ? cell.cellIndex : cell.cellIndex - 1
}

/**
 * The width the column's content wants on one line, padding included.
 *
 * Measured by unwrapping the column for a single layout read and putting it
 * back in the same frame, so no reader ever sees the unwrapped state.
 */
export function naturalColumnWidth(
  table: HTMLTableElement,
  columnIndex: number,
): number | null {
  const cells = Array.from(table.rows)
    .map((row) => row.cells[columnIndex])
    .filter((cell): cell is HTMLTableCellElement => !!cell)
  if (cells.length === 0) return null

  const previous = cells.map((cell) => cell.style.whiteSpace)
  for (const cell of cells) cell.style.whiteSpace = 'nowrap'
  const width = Math.max(...cells.map((cell) => cell.scrollWidth))
  cells.forEach((cell, i) => {
    if (previous[i]) cell.style.whiteSpace = previous[i]
    else cell.style.removeProperty('white-space')
  })
  return width
}

/**
 * Hold the table block's height for the length of a drag.
 *
 * Reflowing under the pointer is the point: the column takes the width, the
 * text rewraps, the neighbour absorbs the delta. What is not the point is the
 * rest of the document travelling with it — a cell that rewraps from three
 * lines to two makes the block 24px shorter, and every paragraph below it jumps
 * up, on every frame of the drag. So the block keeps its starting height while
 * the columns move inside it, and takes its new height once, on release, over
 * the same 160ms a dropped row settles in.
 *
 * A floor rather than a fixed height: a drag that makes the block *taller* still
 * grows immediately, because pushing down as you narrow a column reads as caused
 * by the drag rather than as a jump.
 */
function reserveBlockHeight(table: HTMLTableElement): () => void {
  const wrapper = table.closest('.tableWrapper')
  const block = wrapper instanceof HTMLElement ? wrapper : table
  const start = block.getBoundingClientRect().height
  block.style.minHeight = `${start}px`

  return () => {
    block.style.removeProperty('min-height')
    const natural = block.getBoundingClientRect().height
    const settles =
      Math.abs(natural - start) >= 1 &&
      !block.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!settles) {
      block.style.removeProperty('transition')
      return
    }
    block.style.minHeight = `${start}px`
    // Flush the floor before transitioning off it, or the browser coalesces
    // both writes and the settle never runs.
    void block.offsetHeight
    block.style.transition = `min-height ${DRAG_SETTLE_MS}ms var(--ease-premium)`
    block.style.minHeight = `${natural}px`
    setTimeout(() => {
      block.style.removeProperty('min-height')
      block.style.removeProperty('transition')
    }, DRAG_SETTLE_MS)
  }
}

/**
 * Write one width across every cell of a column — the same transaction shape
 * the resize plugin commits on mouseup, so a fitted column and a dragged one
 * are indistinguishable to undo and to the serializer.
 */
function setColumnWidth(editor: Editor, cellPos: number, width: number): void {
  const view = editor.view
  const $cell = view.state.doc.resolve(cellPos)
  const table = $cell.node(-1)
  const cellNode = $cell.nodeAfter
  if (!cellNode) return
  const map = TableMap.get(table)
  const start = $cell.start(-1)
  const col = map.colCount($cell.pos - start) + cellNode.attrs.colspan - 1
  const tr = view.state.tr

  for (let row = 0; row < map.height; row++) {
    const mapIndex = row * map.width + col
    if (row && map.map[mapIndex] === map.map[mapIndex - map.width]) continue
    const pos = map.map[mapIndex]
    const node = table.nodeAt(pos)
    if (!node) continue
    const index = node.attrs.colspan === 1 ? 0 : col - map.colCount(pos)
    if (node.attrs.colwidth?.[index] === width) continue
    const colwidth: number[] = node.attrs.colwidth
      ? [...node.attrs.colwidth]
      : Array.from({ length: node.attrs.colspan }, () => 0)
    colwidth[index] = width
    tr.setNodeMarkup(start + pos, null, { ...node.attrs, colwidth })
  }
  if (tr.docChanged) view.dispatch(tr)
}

export function installLiveTableResize(editor: Editor): () => void {
  const editorElement = editor.view.dom
  const ownerWindow = editorElement.ownerDocument.defaultView ?? window
  let candidates: number[] = []
  let releaseBlockHeight: (() => void) | null = null

  const begin = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const cell = target?.closest('td, th')
    const table = cell?.closest('table')
    if (!(cell instanceof HTMLTableCellElement) || !(table instanceof HTMLTableElement)) return

    // ProseMirror installs its drag state in this same event turn; wait for it
    // so a move that arrives before the drag exists cannot be snapped against
    // stale candidates.
    queueMicrotask(() => {
      if (!columnResizingPluginKey.getState(editor.state)?.dragging) return
      releaseBlockHeight?.()
      releaseBlockHeight = reserveBlockHeight(table)
      const columnIndex = grabbedColumnIndex(cell, event.clientX)
      const columnCount = table.rows[0]?.cells.length ?? 0
      candidates = columnSnapCandidates(
        table.getBoundingClientRect().width,
        columnCount,
        columnIndex >= 0 ? naturalColumnWidth(table, columnIndex) : null,
      )
    })
  }

  // Capture, so this runs before the plugin's own window listener reads the
  // coordinates — it is the same event object, carrying a corrected clientX.
  const snap = (event: MouseEvent) => {
    const dragging = columnResizingPluginKey.getState(editor.state)?.dragging
    if (!dragging || candidates.length === 0) return
    const x = snappedClientX(dragging, event.clientX, candidates)
    if (x === event.clientX) return
    Object.defineProperty(event, 'clientX', { value: x, configurable: true })
  }

  const endDrag = () => {
    candidates = []
    releaseBlockHeight?.()
    releaseBlockHeight = null
  }

  const fitToContent = (event: MouseEvent) => {
    const activeHandle = columnResizingPluginKey.getState(editor.state)?.activeHandle ?? -1
    if (activeHandle === -1) return
    const target = event.target instanceof Element ? event.target : null
    const cell = target?.closest('td, th')
    const table = cell?.closest('table')
    if (!(cell instanceof HTMLTableCellElement) || !(table instanceof HTMLTableElement)) return
    const columnIndex = grabbedColumnIndex(cell, event.clientX)
    if (columnIndex < 0) return
    const width = naturalColumnWidth(table, columnIndex)
    if (width === null) return
    event.preventDefault()
    setColumnWidth(editor, activeHandle, Math.round(width))
  }

  editorElement.addEventListener('mousedown', begin)
  editorElement.addEventListener('dblclick', fitToContent)
  ownerWindow.addEventListener('mousemove', snap, true)
  ownerWindow.addEventListener('mouseup', endDrag)
  ownerWindow.addEventListener('blur', endDrag)

  return () => {
    editorElement.removeEventListener('mousedown', begin)
    editorElement.removeEventListener('dblclick', fitToContent)
    ownerWindow.removeEventListener('mousemove', snap, true)
    ownerWindow.removeEventListener('mouseup', endDrag)
    ownerWindow.removeEventListener('blur', endDrag)
    endDrag()
  }
}
