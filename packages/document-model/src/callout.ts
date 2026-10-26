import { Node, mergeAttributes } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'

/** The kinds of a GitHub alert, which a callout is. */
export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

/** The label each kind shows, and the order a reader steps through them. */
export const CALLOUT_LABELS = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
} as const satisfies Record<CalloutKind, string>

/** A marker line, then the quoted lines that follow it. A marker with text on
 *  its own line (`> [!NOTE] aside`) is a quote, as it is on GitHub. */
const CALLOUT_RE = /^ {0,3}>[ \t]*\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/i

/** The kind a marker or an attribute names; an unknown kind reads as a note. */
export function calloutKind(value: string | null | undefined): CalloutKind {
  const kind = (value ?? '').toLowerCase()
  return CALLOUT_KINDS.find((candidate) => candidate === kind) ?? 'note'
}

/**
 * A callout (`> [!NOTE]` and its kin): a labelled block of prose. The file
 * keeps GitHub's form, so a document reads the same on GitHub and in Solus.
 * The editor adds a node view; the host uses it as it is.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => calloutKind(element.getAttribute('data-kind')),
        renderHTML: (attributes) => ({ 'data-kind': calloutKind(attributes.kind) }),
      },
    }
  },

  markdownTokenizer: {
    name: 'callout',
    level: 'block',
    start: (src: string) => src.search(/(?:^|\n) {0,3}>[ \t]*\[!/),
    tokenize(src, _tokens, lexer) {
      const match = CALLOUT_RE.exec(src)
      if (!match) return undefined
      const body = match[2]
        .split('\n')
        .map((line) => line.replace(/^ {0,3}> ?/, ''))
        .join('\n')
      return { type: 'callout', raw: match[0], kind: calloutKind(match[1]), tokens: lexer.blockTokens(body) }
    },
  },

  parseMarkdown(token, helpers) {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren
    const children: JSONContent[] = parseBlocks(token.tokens ?? [])
    // The schema needs one block; a marker with no body is an empty callout.
    return helpers.createNode('callout', { kind: calloutKind(token.kind) }, children.length > 0 ? children : [helpers.createNode('paragraph')])
  },

  renderMarkdown(node, helpers) {
    const marker = `> [!${calloutKind(node.attrs?.kind).toUpperCase()}]`
    const blocks = (node.content ?? []).map((child, index) =>
      (helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]))
        .split('\n')
        .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
        .join('\n'),
    )
    return [marker, ...(blocks.length > 0 ? [blocks.join('\n>\n')] : [])].join('\n')
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]', contentElement: '.prose-callout-body' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = calloutKind(node.attrs.kind)
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'prose-callout', role: 'note' }),
      ['span', { class: 'prose-callout-label', contenteditable: 'false' }, CALLOUT_LABELS[kind]],
      ['div', { class: 'prose-callout-body' }, 0],
    ]
  },
})
