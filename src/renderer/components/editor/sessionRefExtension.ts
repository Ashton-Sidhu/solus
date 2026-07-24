import { Node, mergeAttributes } from '@tiptap/core'
import type { AgentId } from '../../../shared/types'
import { tokenClassName, TOKEN_ICONS } from './tokenStyle'

export interface SessionRefAttrs {
  sessionId: string
  provider: AgentId
  title: string
  cwd: string
}

export const SessionRefExtension = Node.create({
  name: 'sessionReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  // A dedicated tokenizer (not markdownTokenName: 'link') because inline
  // parsing dispatches each token type to a single handler — claiming `link`
  // here would swallow every other link in the document. Marked tries
  // extension tokenizers before its built-in link rule, so session:// links
  // become sessionReference tokens and everything else stays a normal link.
  markdownTokenizer: {
    name: 'sessionReference',
    level: 'inline',
    start: (src: string) =>
      /\[(?:\\.|[^\]\\\n])*\]\(session:\/\//.exec(src)?.index ?? -1,
    tokenize(src: string) {
      const m = /^\[((?:\\.|[^\]\\\n])*)\]\((session:\/\/[^)\s]*)\)/.exec(src)
      if (!m) return undefined
      return { type: 'sessionReference', raw: m[0], text: m[1], href: m[2] }
    },
  },

  parseMarkdown(token) {
    const url = new URL(token.href as string)
    return {
      type: 'sessionReference',
      attrs: {
        sessionId: url.searchParams.get('sessionId'),
        provider: url.searchParams.get('provider'),
        cwd: url.searchParams.get('cwd') || '',
        title: (token.text || '').replace(/\\([\[\]])/g, '$1'),
      },
    }
  },

  renderMarkdown(node) {
    const params = new URLSearchParams({
      sessionId: node.attrs?.sessionId,
      provider: node.attrs?.provider,
      cwd: node.attrs?.cwd ?? '',
    })
    const safeTitle = (node.attrs?.title ?? '').replace(/[\[\]]/g, '\\$&')
    return `[${safeTitle}](session://ref?${params})`
  },

  addAttributes() {
    return {
      sessionId: { default: null },
      provider: { default: null },
      title: { default: '' },
      cwd: { default: '' },
    }
  },

  parseHTML() {
    return [
      { tag: 'span[data-session-ref]' },
      {
        tag: 'a[href^="session://"]',
        getAttrs(dom: HTMLElement) {
          const url = new URL(dom.getAttribute('href')!)
          return {
            sessionId: url.searchParams.get('sessionId'),
            provider: url.searchParams.get('provider'),
            cwd: url.searchParams.get('cwd') || '',
            title: dom.textContent || '',
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-session-ref': node.attrs.sessionId,
      contenteditable: 'false',
      class: tokenClassName('session'),
    }),
      ['span', { class: 'solus-token__icon' }, TOKEN_ICONS.session],
      ['span', {}, node.attrs.title],
    ]
  },

})
