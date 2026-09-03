import { Extension, type Editor } from '@tiptap/core'
import type { ResolvedPos } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { CellSelection, moveTableColumn, moveTableRow } from '@tiptap/pm/tables'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * The table under the keyboard.
 *
 * Chrome is the expensive way to edit a table: it has to be found, and finding
 * it means leaving the text. The two most common edits — another row, another
 * column — never require a grip, a tab, or the block bar here. Tab past the
 * last cell grows the table and lands in it; Enter on a row you did not fill
 * takes the row back and puts you below the table; ⌥ plus an arrow moves the
 * row or column you are in; and Backspace empties a selection before it removes
 * anything, so nothing structural is ever one keystroke away.
 */

/** New rows and columns grow in rather than appearing, then focus lands. */
export const TABLE_GROW_MS = 140

interface GrowRange {
  from: number
  to: number
}

const growKey = new PluginKey<GrowRange[]>('tableGrow')

/** The depth of the enclosing node with the given table role, if any. */
function depthWithRole($pos: ResolvedPos, role: 'row' | 'table'): number | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.spec.tableRole === role) return depth
  }
  return null
}

function rowIsEmpty($pos: ResolvedPos): boolean {
  const depth = depthWithRole($pos, 'row')
  if (depth === null) return false
  return $pos.node(depth).textContent.trim() === ''
}

/**
 * The row, or every cell of the column, the caret currently sits in — a column
 * grows in across all its rows at once, not one cell at a time.
 */
function rangesAroundSelection(editor: Editor, axis: 'row' | 'column'): GrowRange[] {
  const { $from } = editor.state.selection
  if (axis === 'row') {
    const depth = depthWithRole($from, 'row')
    if (depth === null) return []
    const from = $from.before(depth)
    return [{ from, to: from + $from.node(depth).nodeSize }]
  }

  const tableDepth = depthWithRole($from, 'table')
  const rowDepth = depthWithRole($from, 'row')
  if (tableDepth === null || rowDepth === null) return []
  const columnIndex = $from.index(rowDepth)
  const ranges: GrowRange[] = []
  let rowPos = $from.start(tableDepth)
  $from.node(tableDepth).forEach((row) => {
    let cellPos = rowPos + 1
    row.forEach((cell, _offset, index) => {
      if (index === columnIndex) ranges.push({ from: cellPos, to: cellPos + cell.nodeSize })
      cellPos += cell.nodeSize
    })
    rowPos += row.nodeSize
  })
  return ranges
}

function markGrown(editor: Editor, axis: 'row' | 'column'): void {
  const ranges = rangesAroundSelection(editor, axis)
  if (ranges.length === 0) return
  editor.view.dispatch(editor.state.tr.setMeta(growKey, ranges))
}

/**
 * Add, land the caret in what was added, and let it grow in. Exported so the
 * block bar's "+ row" and "+ col" produce the same result the keyboard does —
 * one behaviour, two ways in.
 */
export function growTable(editor: Editor, axis: 'row' | 'column'): boolean {
  const chain = editor.chain()
  const added =
    axis === 'row'
      ? chain.addRowAfter().goToNextCell().run()
      : chain.addColumnAfter().goToNextCell().run()
  if (!added) return false
  markGrown(editor, axis)
  return true
}

/**
 * Take back the row the caret is in and put the caret below the table. The last
 * row takes the table with it — an empty table left behind is a block the reader
 * then has to delete a second way.
 */
function dropRowAndExit(editor: Editor): boolean {
  const { state } = editor.view
  const tableDepth = depthWithRole(state.selection.$from, 'table')
  if (tableDepth === null) return false
  const tablePos = state.selection.$from.before(tableDepth)
  const isLastRow = state.selection.$from.node(tableDepth).childCount <= 1

  const removed = isLastRow
    ? editor.chain().deleteTable().run()
    : editor.chain().deleteRow().run()
  if (!removed) return false

  const tr = editor.state.tr
  const remaining = tr.doc.resolve(tablePos).nodeAfter
  const after =
    remaining?.type.spec.tableRole === 'table' ? tablePos + remaining.nodeSize : tablePos
  const paragraph = editor.state.schema.nodes.paragraph
  if (!tr.doc.resolve(after).nodeAfter && paragraph) tr.insert(after, paragraph.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(after), 1))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

function moveBy(editor: Editor, axis: 'row' | 'column', delta: number): boolean {
  const $from = editor.state.selection.$from

  if (axis === 'row') {
    const tableDepth = depthWithRole($from, 'table')
    if (tableDepth === null) return false
    const index = $from.index(tableDepth)
    const to = index + delta
    if (to < 0 || to >= $from.node(tableDepth).childCount) return false
    return moveTableRow({ from: index, to })(editor.state, editor.view.dispatch)
  }

  const rowDepth = depthWithRole($from, 'row')
  if (rowDepth === null) return false
  const index = $from.index(rowDepth)
  const to = index + delta
  if (to < 0 || to >= $from.node(rowDepth).childCount) return false
  return moveTableColumn({ from: index, to })(editor.state, editor.view.dispatch)
}

/**
 * Backspace over a selection clears it. Only a second press — on cells that are
 * already empty — takes the row or column away, so the structural edit always
 * has a preceding one that showed what it would act on.
 */
function clearThenRemove(editor: Editor): boolean {
  const { selection } = editor.state
  if (!(selection instanceof CellSelection)) return false

  let hasContent = false
  selection.forEachCell((cell) => {
    if (cell.textContent.trim() !== '') hasContent = true
  })
  if (hasContent) return editor.chain().deleteSelection().run()

  // Every cell selected is the whole table, and the table extension already
  // owns that verb. Only a single-axis selection resolves to a row or column.
  if (selection.isRowSelection() && selection.isColSelection()) return false
  if (selection.isRowSelection()) return editor.chain().deleteRow().run()
  if (selection.isColSelection()) return editor.chain().deleteColumn().run()
  return false
}

export const TableFlow = Extension.create({
  name: 'tableFlow',
  // Ahead of the table extension's own Tab and Backspace, which this narrows
  // rather than replaces: every handler here falls through when its case does
  // not apply, so the stock behaviour is what runs by default.
  priority: 1000,

  addKeyboardShortcuts() {
    const editor = this.editor
    return {
      // The "+ row" tab and the block bar are for the mouse. Tab is the hand
      // that is already on the keyboard.
      Tab: () => {
        if (!editor.isActive('table')) return false
        if (editor.commands.goToNextCell()) return true
        return growTable(editor, 'row')
      },
      Enter: () => {
        if (!editor.isActive('table')) return false
        if (!rowIsEmpty(editor.state.selection.$from)) return false
        return dropRowAndExit(editor)
      },
      'Alt-ArrowUp': () => moveBy(editor, 'row', -1),
      'Alt-ArrowDown': () => moveBy(editor, 'row', 1),
      'Alt-ArrowLeft': () => moveBy(editor, 'column', -1),
      'Alt-ArrowRight': () => moveBy(editor, 'column', 1),
      Backspace: () => clearThenRemove(editor),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<GrowRange[]>({
        key: growKey,
        state: {
          init: () => [],
          apply(tr: Transaction, ranges: GrowRange[]) {
            const next = tr.getMeta(growKey)
            if (Array.isArray(next)) return next
            if (tr.getMeta(growKey) === null) return []
            if (!tr.docChanged) return ranges
            return ranges.map((range) => ({
              from: tr.mapping.map(range.from),
              to: tr.mapping.map(range.to),
            }))
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | null = null
          return {
            update() {
              if (growKey.getState(view.state)?.length === 0) return
              if (timer) clearTimeout(timer)
              timer = setTimeout(() => {
                view.dispatch(view.state.tr.setMeta(growKey, null))
              }, TABLE_GROW_MS)
            },
            destroy() {
              if (timer) clearTimeout(timer)
            },
          }
        },
        props: {
          // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
          decorations(state) {
            const ranges = growKey.getState(state)
            if (!ranges || ranges.length === 0) return null
            return DecorationSet.create(
              state.doc,
              ranges.map((range) =>
                Decoration.node(range.from, range.to, { class: 'doc-table-entering' }),
              ),
            )
          },
        },
      }),
    ]
  },
})
