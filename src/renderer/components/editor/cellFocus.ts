import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Marks the table cell the caret is inside, so it can take the accent ring.
 *
 * ProseMirror only classes cells for a *cell selection* (`.selectedCell`); a
 * plain caret inside a cell leaves nothing in the DOM to hang a style off, and
 * the design asks for the focused cell to be the one place terracotta enters
 * the prose column.
 */
export const CellFocus = Extension.create({
  name: 'cellFocus',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('cellFocus'),
        props: {
          // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
          decorations(state) {
            const { selection } = state
            // A cell selection already washes every cell it covers. Ringing one
            // of them on top of that reads as two competing states.
            if (selection instanceof CellSelection) return null

            const { $from } = selection
            for (let depth = $from.depth; depth > 0; depth--) {
              const node = $from.node(depth)
              const role = node.type.spec.tableRole
              if (role !== 'cell' && role !== 'header_cell') continue
              const pos = $from.before(depth)
              // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
              return DecorationSet.create(state.doc, [
                Decoration.node(pos, pos + node.nodeSize, { class: 'doc-cell-focus' }),
              ])
            }
            return null
          },
        },
      }),
    ]
  },
})
