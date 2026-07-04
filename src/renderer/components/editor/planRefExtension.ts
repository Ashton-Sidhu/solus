import { Node, mergeAttributes } from '@tiptap/core'
import { tokenClassName, TOKEN_ICONS, type TokenVariant } from './tokenStyle'

export interface PlanRefAttrs {
  planId: string
  sessionId: string
  planToolUseId: string
  title: string
  status: 'pending' | 'accepted' | 'rejected'
}

const STATUS_VARIANT: Record<string, TokenVariant> = {
  pending: 'plan-pending',
  accepted: 'plan-accepted',
  rejected: 'plan-rejected',
}

const STATUS_ICON: Record<string, keyof typeof TOKEN_ICONS> = {
  pending: 'plan',
  accepted: 'planAccepted',
  rejected: 'planRejected',
}

export const PlanRefExtension = Node.create({
  name: 'planReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  // A dedicated tokenizer (not markdownTokenName: 'link') because inline
  // parsing dispatches each token type to a single handler — claiming `link`
  // here would swallow every other link in the document. Marked tries
  // extension tokenizers before its built-in link rule, so plan:// links
  // become planReference tokens and everything else stays a normal link.
  markdownTokenizer: {
    name: 'planReference',
    level: 'inline',
    start: (src: string) =>
      /\[(?:\\.|[^\]\\\n])*\]\(plan:\/\//.exec(src)?.index ?? -1,
    tokenize(src: string) {
      const m = /^\[((?:\\.|[^\]\\\n])*)\]\((plan:\/\/[^)\s]*)\)/.exec(src)
      if (!m) return undefined
      return { type: 'planReference', raw: m[0], text: m[1], href: m[2] }
    },
  },

  parseMarkdown(token) {
    const url = new URL(token.href as string)
    return {
      type: 'planReference',
      attrs: {
        planId: url.searchParams.get('planId'),
        sessionId: url.searchParams.get('sessionId'),
        planToolUseId: url.searchParams.get('planToolUseId'),
        status: url.searchParams.get('status') || 'pending',
        title: (token.text || '').replace(/\\([\[\]])/g, '$1'),
      },
    }
  },

  renderMarkdown(node) {
    const params = new URLSearchParams({
      planId: node.attrs?.planId,
      sessionId: node.attrs?.sessionId,
      planToolUseId: node.attrs?.planToolUseId,
      status: node.attrs?.status,
    })
    const safeTitle = (node.attrs?.title ?? '').replace(/[\[\]]/g, '\\$&')
    return `[${safeTitle}](plan://ref?${params})`
  },

  addAttributes() {
    return {
      planId: { default: null },
      sessionId: { default: null },
      planToolUseId: { default: null },
      title: { default: '' },
      status: { default: 'pending' },
    }
  },

  parseHTML() {
    return [
      { tag: 'span[data-plan-ref]' },
      {
        tag: 'a[href^="plan://"]',
        getAttrs(dom: HTMLElement) {
          const url = new URL(dom.getAttribute('href')!)
          return {
            planId: url.searchParams.get('planId'),
            sessionId: url.searchParams.get('sessionId'),
            planToolUseId: url.searchParams.get('planToolUseId'),
            status: url.searchParams.get('status') || 'pending',
            title: dom.textContent || '',
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const variant = STATUS_VARIANT[node.attrs.status] ?? 'plan-pending'
    const icon = TOKEN_ICONS[STATUS_ICON[node.attrs.status] ?? 'plan']

    return ['span', mergeAttributes(HTMLAttributes, {
      'data-plan-ref': node.attrs.planId,
      contenteditable: 'false',
      class: tokenClassName(variant),
    }),
      ['span', { class: 'solus-token__icon' }, icon],
      ['span', {}, node.attrs.title],
    ]
  },

})
