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
  // A dedicated tokenizer (not markdownTokenName: 'link') because inline
  // parsing dispatches each token type to a single handler — claiming `link`
  // here would swallow every other link in the document. Marked tries
  // extension tokenizers before its built-in link rule, so work:// links
  // become workReference tokens and everything else stays a normal link.
  markdownTokenizer: {
    name: 'workReference',
    level: 'inline',
    start: (src: string) =>
      /\[(?:\\.|[^\]\\\n])*\]\(work:\/\//.exec(src)?.index ?? -1,
    tokenize(src: string) {
      const m = /^\[((?:\\.|[^\]\\\n])*)\]\((work:\/\/[^)\s]*)\)/.exec(src)
      if (!m) return undefined
      return { type: 'workReference', raw: m[0], text: m[1], href: m[2] }
    },
  },

  parseMarkdown(token) {
    const url = new URL(token.href as string)
    return {
      type: 'workReference',
      attrs: {
        workId: url.searchParams.get('workId'),
        type: url.searchParams.get('type') || 'doc',
        title: (token.text || '').replace(/\\([\[\]])/g, '$1'),
      },
    }
  },

  renderMarkdown(node) {
    const params = new URLSearchParams({
      workId: node.attrs?.workId,
      type: node.attrs?.type,
    })
    const safeTitle = (node.attrs?.title ?? '').replace(/[\[\]]/g, '\\$&')
    return `[${safeTitle}](work://ref?${params})`
  },

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

})
