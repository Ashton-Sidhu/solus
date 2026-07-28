import { Node, mergeAttributes } from '@tiptap/core'
import { serializeReferenceToken } from './reference-tokens'
import { tokenClassName } from './tokenStyle'

export interface SlashRefAttrs {
  /** Full slash command including leading `/` (e.g. `/init`). */
  command: string
}

export const SlashRefExtension = Node.create({
  name: 'slashReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      command: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-slash-ref]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-slash-ref': node.attrs.command,
      contenteditable: 'false',
      class: tokenClassName('slash', true),
    }),
      ['span', {}, node.attrs.command],
    ]
  },

  renderMarkdown(node) {
    return serializeReferenceToken({
      kind: 'slash',
      command: node.attrs?.command ?? '',
    })
  },
})
