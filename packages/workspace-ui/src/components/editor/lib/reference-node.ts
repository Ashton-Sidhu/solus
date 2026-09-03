import { Node, mergeAttributes } from '@tiptap/core'
import { serializeReferenceToken, type ReferenceToken } from '../reference-tokens'
import { linkTokenClassName, type IconArray, type TokenVariant } from '../tokenStyle'

/**
 * One shape for every URL-scheme reference node — plan, work, PR, session.
 *
 * Each is an inline atom that round-trips through markdown as
 * `[label](scheme://?query)`, pastes in from an `<a href="scheme://…">`, and
 * renders as the shared reference chip. Only the scheme, the attribute set,
 * and how the URL maps onto it differ, so those are the whole spec.
 */
export interface ReferenceNodeSpec<Attrs extends object> {
  /** ProseMirror node name, e.g. `planReference`. */
  name: string
  /** URL scheme without the `://`, e.g. `plan`. */
  scheme: string
  /** The `data-*` attribute the chip carries, and what `parseHTML` matches. */
  dataAttr: string
  /** Attribute defaults, in the shape Tiptap's `addAttributes` wants. */
  attrs: { [K in keyof Attrs]: { default: Attrs[K] | null } }
  /** The href's query plus the link text, resolved into node attrs. Shared by
   *  the markdown and the HTML parse paths so the two can never disagree. */
  fromUrl: (url: URL, label: string) => Attrs
  /** The canonical token the markdown and plain-text serializers write. Node
   *  attrs can carry their null defaults, so every field needs a fallback. */
  toToken: (attrs: Partial<Attrs>) => ReferenceToken
  /** Value of the `data-*` attribute — the id a click handler reads back. */
  idOf: (attrs: Attrs) => string | number
  /** Chip text. */
  label: (attrs: Attrs) => string
  variant: (attrs: Attrs) => TokenVariant
  icon: (attrs: Attrs) => IconArray
}

/** `[label](scheme://…)` with the label's escaped brackets still escaped. */
function linkPattern(scheme: string, anchored: boolean): RegExp {
  const label = String.raw`(?:\\.|[^\]\\\n])*`
  return anchored
    ? new RegExp(String.raw`^\[(${label})\]\((${scheme}:\/\/[^)\s]*)\)`)
    : new RegExp(String.raw`\[${label}\]\(${scheme}:\/\/`)
}

function unescapeLabel(text: string): string {
  return text.replaceAll('\\[', '[').replaceAll('\\]', ']')
}

export function createReferenceNode<Attrs extends object>(spec: ReferenceNodeSpec<Attrs>) {
  const startPattern = linkPattern(spec.scheme, false)
  const tokenPattern = linkPattern(spec.scheme, true)

  return Node.create({
    name: spec.name,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    // A dedicated tokenizer (not markdownTokenName: 'link') because inline
    // parsing dispatches each token type to a single handler — claiming `link`
    // would swallow every other link in the document. Marked tries extension
    // tokenizers before its built-in link rule, so `scheme://` links become
    // this node and everything else stays a normal link.
    markdownTokenizer: {
      name: spec.name,
      level: 'inline',
      start: (src: string) => startPattern.exec(src)?.index ?? -1,
      tokenize(src: string) {
        const match = tokenPattern.exec(src)
        if (!match) return undefined
        return { type: spec.name, raw: match[0], text: match[1], href: match[2] }
      },
    },

    parseMarkdown(token) {
      // The tokenizer above is the only producer of this token type, and it
      // always sets both fields from the regex captures.
      const href = String(token.href ?? '')
      const text = String(token.text ?? '')
      return { type: spec.name, attrs: spec.fromUrl(new URL(href), unescapeLabel(text)) }
    },

    renderMarkdown(node) {
      // SAFETY: this node's schema is `spec.attrs`, so its attrs are `Attrs`
      // with each field possibly still at its null default.
      return serializeReferenceToken(spec.toToken((node.attrs ?? {}) as Partial<Attrs>))
    },

    // An atom contributes nothing to a plain-text copy unless it says
    // otherwise. Emit the same canonical token the markdown serializer does.
    renderText({ node }) {
      // SAFETY: same schema invariant as renderMarkdown above.
      return serializeReferenceToken(spec.toToken(node.attrs as Partial<Attrs>))
    },

    addAttributes() {
      return spec.attrs
    },

    parseHTML() {
      return [
        { tag: `span[${spec.dataAttr}]` },
        {
          tag: `a[href^="${spec.scheme}://"]`,
          getAttrs(dom: HTMLElement) {
            return spec.fromUrl(new URL(dom.getAttribute('href')!), dom.textContent || '')
          },
        },
      ]
    },

    renderHTML({ node, HTMLAttributes }) {
      // SAFETY: this node's schema is `spec.attrs`; every insert path and both
      // parse paths write the full `Attrs` shape.
      const attrs = node.attrs as Attrs
      return [
        'span',
        mergeAttributes(HTMLAttributes, {
          [spec.dataAttr]: spec.idOf(attrs),
          contenteditable: 'false',
          class: linkTokenClassName(spec.variant(attrs)),
        }),
        ['span', { class: 'solus-token__icon' }, spec.icon(attrs)],
        ['span', {}, spec.label(attrs)],
      ]
    },
  })
}
