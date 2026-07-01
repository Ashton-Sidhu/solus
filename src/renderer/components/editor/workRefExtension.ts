import { Node, mergeAttributes } from '@tiptap/core'
import { tokenClassName, TOKEN_ICONS } from './tokenStyle'

export interface WorkRefAttrs {
  workId: string
  title: string
  type: 'doc' | 'slides' | 'diagram'
}

export const WorkRefExtension = Node.create({
  name: 'workReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      workId: { default: null },
      title: { default: '' },
      type: { default: 'doc' },
    }
  },

  parseHTML() {
    return [
      { tag: 'span[data-work-ref]' },
      {
        tag: 'a[href^="work://"]',
        getAttrs(dom: HTMLElement) {
          const url = new URL(dom.getAttribute('href')!)
          return {
            workId: url.searchParams.get('workId'),
            type: url.searchParams.get('type') || 'doc',
            title: dom.textContent || '',
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-work-ref': node.attrs.workId,
      contenteditable: 'false',
      class: tokenClassName('work'),
    }),
      ['span', { class: 'solus-token__icon' }, TOKEN_ICONS.work],
      ['span', {}, node.attrs.title],
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const params = new URLSearchParams({
            workId: node.attrs.workId,
            type: node.attrs.type,
          })
          const safeTitle = node.attrs.title.replace(/[\[\]]/g, '\\$&')
          state.write(`[${safeTitle}](work://ref?${params})`)
        },
        parse: {},
      },
    }
  },
})
