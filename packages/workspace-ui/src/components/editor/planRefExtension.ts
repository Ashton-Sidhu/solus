import { Node, mergeAttributes } from '@tiptap/core'
import { serializeReferenceToken } from './reference-tokens'
import { linkTokenClassName, TOKEN_ICONS, type TokenVariant } from './tokenStyle'
import { z } from 'zod'

export interface PlanRefAttrs {
  planId: string
  sessionId: string
  planToolUseId: string
  title: string
  status: 'pending' | 'accepted' | 'rejected'
}

const STATUS_VARIANT = {
  pending: 'plan-pending',
  accepted: 'plan-accepted',
  rejected: 'plan-rejected',
} satisfies Record<PlanRefAttrs['status'], TokenVariant>

const STATUS_ICON = {
  pending: 'plan',
  accepted: 'planAccepted',
  rejected: 'planRejected',
} satisfies Record<PlanRefAttrs['status'], keyof typeof TOKEN_ICONS>

const markdownPlanTokenSchema = z.object({
  href: z.string(),
  text: z.string().optional(),
})

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
    const parsed = markdownPlanTokenSchema.parse(token)
    const url = new URL(parsed.href)
    return {
      type: 'planReference',
      attrs: {
        planId: url.searchParams.get('planId'),
        sessionId: url.searchParams.get('sessionId'),
        planToolUseId: url.searchParams.get('planToolUseId'),
        status: url.searchParams.get('status') || 'pending',
        title: (parsed.text || '').replaceAll('\\[', '[').replaceAll('\\]', ']'),
      },
    }
  },

  renderMarkdown(node) {
    return serializeReferenceToken({
      kind: 'plan',
      planId: node.attrs?.planId,
      sessionId: node.attrs?.sessionId,
      planToolUseId: node.attrs?.planToolUseId,
      status: node.attrs?.status,
      title: node.attrs?.title ?? '',
    })
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
      class: linkTokenClassName(variant),
    }),
      ['span', { class: 'solus-token__icon' }, icon],
      ['span', {}, node.attrs.title],
    ]
  },

})
