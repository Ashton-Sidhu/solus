import { Node, mergeAttributes } from '@tiptap/core'
import { parsePersonMentionHref, personMentionMarkdown } from '@solus/contracts/mentions'

/** `[@label](person://ref?…)` with the label's escaped brackets still escaped. */
const LABEL = String.raw`(?:\\.|[^\]\\\n])*`
const MENTION_START = new RegExp(String.raw`\[${LABEL}\]\(person:\/\/`)
const MENTION = new RegExp(String.raw`^\[(${LABEL})\]\((person:\/\/[^)\s]*)\)`)

/**
 * A mention of an organization member in a work body, stored as
 * `[@Ann Lee](person://ref?userId=u_123)`. The node keeps the user id and the
 * name saved with the mention. The editor extends it with a chip that shows
 * the member's current name; this rendering is the saved name only.
 */
export const PersonReference = Node.create({
  name: 'personReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      userId: { default: null },
      name: { default: '' },
    }
  },

  // A dedicated tokenizer (not the `link` token) because inline parsing sends
  // each token type to one handler. Marked tries extension tokenizers before
  // its link rule, so a `person://` link becomes this node and every other
  // link stays a link. A link without a user id is not a mention.
  markdownTokenizer: {
    name: 'personReference',
    level: 'inline',
    start: (src: string) => MENTION_START.exec(src)?.index ?? -1,
    tokenize(src: string) {
      const match = MENTION.exec(src)
      const mention = match ? parsePersonMentionHref(match[2], match[1]) : null
      if (!match || !mention) return undefined
      return { type: 'personReference', raw: match[0], userId: mention.userId, name: mention.name }
    },
  },

  parseMarkdown(token) {
    return { type: 'personReference', attrs: { userId: String(token.userId ?? ''), name: String(token.name ?? '') } }
  },

  renderMarkdown(node) {
    return personMentionMarkdown({ userId: String(node.attrs?.userId ?? ''), name: String(node.attrs?.name ?? '') })
  },

  // An atom contributes nothing to a plain-text copy unless it says otherwise.
  renderText({ node }) {
    return personMentionMarkdown({ userId: String(node.attrs.userId ?? ''), name: String(node.attrs.name ?? '') })
  },

  parseHTML() {
    return [
      { tag: 'span[data-person-ref]' },
      {
        tag: 'a[href^="person://"]',
        getAttrs(dom: HTMLElement) {
          const mention = parsePersonMentionHref(dom.getAttribute('href') ?? '', dom.textContent ?? '')
          return mention ? { userId: mention.userId, name: mention.name } : false
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-person-ref': node.attrs.userId, contenteditable: 'false' }),
      `@${String(node.attrs.name ?? '')}`,
    ]
  },
})
