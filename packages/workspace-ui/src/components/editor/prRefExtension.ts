import { Node, mergeAttributes } from '@tiptap/core'
import { serializeReferenceToken, type PrReferenceToken } from './reference-tokens'
import { linkTokenClassName, TOKEN_ICONS } from './tokenStyle'

export interface PrRefAttrs {
  number: number
  title: string
}

function prToken(attrs: Partial<PrRefAttrs> | undefined): PrReferenceToken {
  return { kind: 'pr', number: attrs?.number ?? 0, title: attrs?.title ?? '' }
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
    const url = new URL(String(token.href))
    const number = Number(url.searchParams.get('number'))
    const label = (token.text || '').replaceAll('\\[', '[').replaceAll('\\]', ']')
    return {
      type: 'prReference',
      attrs: {
        number,
        title: label.replace(new RegExp(`^#${number}\\s*`), ''),
      },
    }
  },

  renderMarkdown(node) {
    return serializeReferenceToken(prToken(node.attrs))
  },

  renderText({ node }) {
    return serializeReferenceToken(prToken(node.attrs))
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
      class: linkTokenClassName('pr'),
    }),
      ['span', { class: 'solus-token__icon' }, TOKEN_ICONS.pr],
      ['span', {}, `#${node.attrs.number} ${node.attrs.title}`],
    ]
  },
})
