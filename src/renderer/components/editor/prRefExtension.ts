import { Node, mergeAttributes } from '@tiptap/core'
import { tokenClassName, TOKEN_ICONS } from './tokenStyle'

export interface PrRefAttrs {
  number: number
  title: string
}

export const PrRefExtension = Node.create({
  name: 'prReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  markdownTokenizer: {
    name: 'prReference',
    level: 'inline',
    start: (src: string) =>
      /\[(?:\\.|[^\]\\\n])*\]\(pr:\/\//.exec(src)?.index ?? -1,
    tokenize(src: string) {
      const match = /^\[((?:\\.|[^\]\\\n])*)\]\((pr:\/\/[^)\s]*)\)/.exec(src)
      if (!match) return undefined
      return { type: 'prReference', raw: match[0], text: match[1], href: match[2] }
    },
  },

  parseMarkdown(token) {
    const url = new URL(token.href as string)
    const number = Number(url.searchParams.get('number'))
    const label = (token.text || '').replace(/\\([\[\]])/g, '$1')
    return {
      type: 'prReference',
      attrs: {
        number,
        title: label.replace(new RegExp(`^#${number}\\s*`), ''),
      },
    }
  },

  renderMarkdown(node) {
    const params = new URLSearchParams({
      number: String(node.attrs?.number),
    })
    const safeTitle = (node.attrs?.title ?? '').replace(/[\[\]]/g, '\\$&')
    return `[#${node.attrs?.number} ${safeTitle}](pr://ref?${params})`
  },

  addAttributes() {
    return {
      number: { default: null },
      title: { default: '' },
    }
  },

  parseHTML() {
    return [
      { tag: 'span[data-pr-ref]' },
      {
        tag: 'a[href^="pr://"]',
        getAttrs(dom: HTMLElement) {
          const url = new URL(dom.getAttribute('href')!)
          const number = Number(url.searchParams.get('number'))
          return {
            number,
            title: (dom.textContent || '').replace(new RegExp(`^#${number}\\s*`), ''),
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-pr-ref': node.attrs.number,
      contenteditable: 'false',
      class: tokenClassName('pr'),
    }),
      ['span', { class: 'solus-token__icon' }, TOKEN_ICONS.pr],
      ['span', {}, `#${node.attrs.number} ${node.attrs.title}`],
    ]
  },
})
