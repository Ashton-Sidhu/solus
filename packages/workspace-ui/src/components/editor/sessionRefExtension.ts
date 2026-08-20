import { Node, mergeAttributes } from '@tiptap/core'
import type { AgentId } from '@solus/contracts/types'
import { serializeReferenceToken } from './reference-tokens'
import { linkTokenClassName, TOKEN_ICONS } from './tokenStyle'

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
    const url = new URL(String(token.href))
    return {
      type: 'sessionReference',
      attrs: {
        sessionId: url.searchParams.get('sessionId'),
        provider: url.searchParams.get('provider'),
        serverId: url.searchParams.get('serverId'),
        cwd: url.searchParams.get('cwd') || '',
        title: (token.text || '').replaceAll('\\[', '[').replaceAll('\\]', ']'),
      },
    }
  },

  renderMarkdown(node) {
    return serializeReferenceToken({
      kind: 'session',
      sessionId: node.attrs?.sessionId,
      provider: node.attrs?.provider,
      serverId: node.attrs?.serverId ?? undefined,
      cwd: node.attrs?.cwd ?? '',
      title: node.attrs?.title ?? '',
    })
  },

  addAttributes() {
    return {
      sessionId: { default: null },
      provider: { default: null },
      serverId: { default: null },
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
      class: linkTokenClassName('session'),
    }),
      ['span', { class: 'solus-token__icon' }, TOKEN_ICONS.session],
      ['span', {}, node.attrs.title],
    ]
  },

})
