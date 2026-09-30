import { Node, mergeAttributes } from '@tiptap/core'
import { parseDiagramEmbed, serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import { parseWorkEmbed, serializeWorkEmbed } from '@solus/contracts/work-embed'
import { htmlBlockFence, mermaidBlockFence, serializeHtmlBlock, serializeMermaidBlock } from './fences'

/**
 * The document's custom blocks: their schema and their markdown. The editor
 * extends each one with a node view; the host uses them as they are.
 *
 * A live block holds its payload as an attribute rather than as editable
 * content: it is one definition the renderer draws, not prose the schema
 * should be splitting into paragraphs. Its markdown never changes shape, so
 * the file stays as portable as it was before Solus opened it.
 */

/** Where a fence can open: a line that starts with three backticks or tildes. */
const fenceStart = (src: string) => src.search(/(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/)
/** Where an embed can open: a line that starts with a link. */
const embedStart = (src: string) => /^\s*\[/.exec(src)?.index ?? -1

/** The first line of `src`, and the text a block token consumes for it. */
function firstLine(src: string): { line: string; raw: string } {
  const newline = src.indexOf('\n')
  return newline === -1 ? { line: src, raw: src } : { line: src.slice(0, newline), raw: src.slice(0, newline + 1) }
}

/** A ```mermaid fence in a document or plan, drawn in place. */
export const MermaidBlock = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      source: { default: '' },
    }
  },

  markdownTokenizer: {
    name: 'mermaidBlock',
    level: 'block',
    start: fenceStart,
    tokenize(src: string) {
      const block = mermaidBlockFence(src)
      // Anything else — another language, a `source` fence, an unclosed fence —
      // falls through to marked's own fence rule and stays a code block.
      if (!block) return undefined
      return { type: 'mermaidBlock', raw: block.raw, source: block.source }
    },
  },

  parseMarkdown(token) {
    return { type: 'mermaidBlock', attrs: { source: String(token.source ?? '') } }
  },

  renderMarkdown(node) {
    return serializeMermaidBlock(String(node.attrs?.source ?? ''))
  },

  renderText({ node }) {
    return serializeMermaidBlock(String(node.attrs?.source ?? ''))
  },

  parseHTML() {
    return [{ tag: 'div[data-mermaid-block]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-mermaid-block': '' }), node.attrs.source]
  },
})

/** A ```html fence in a document or plan, rendered live. */
export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      html: { default: '' },
      /** The author or the reader asked for a render in the info string, and
       *  the fence writes that word back so the choice survives a save. */
      explicit: { default: false },
    }
  },

  markdownTokenizer: {
    name: 'htmlBlock',
    level: 'block',
    start: fenceStart,
    tokenize(src: string) {
      const block = htmlBlockFence(src)
      // Anything else — a snippet, another language, an unclosed fence — falls
      // through to marked's own fence rule and stays a code block.
      if (!block) return undefined
      return { type: 'htmlBlock', raw: block.raw, html: block.html, explicit: block.explicit }
    },
  },

  parseMarkdown(token) {
    return { type: 'htmlBlock', attrs: { html: String(token.html ?? ''), explicit: token.explicit === true } }
  },

  renderMarkdown(node) {
    return serializeHtmlBlock(String(node.attrs?.html ?? ''), node.attrs?.explicit === true)
  },

  renderText({ node }) {
    return serializeHtmlBlock(String(node.attrs?.html ?? ''), node.attrs?.explicit === true)
  },

  parseHTML() {
    return [{ tag: 'div[data-html-block]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-html-block': '' }), node.attrs.html]
  },
})

/** A diagram work embedded on its own line: `[title](work://embed?…&type=diagram)`. */
export const DiagramEmbed = Node.create({
  name: 'diagramEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      workId: { default: null },
      title: { default: '' },
    }
  },

  markdownTokenizer: {
    name: 'diagramEmbed',
    level: 'block',
    start: embedStart,
    tokenize(src: string) {
      const { line, raw } = firstLine(src)
      const reference = parseDiagramEmbed(line)
      if (!reference) return undefined
      return { type: 'diagramEmbed', raw, reference }
    },
  },

  parseMarkdown(token) {
    return {
      type: 'diagramEmbed',
      attrs: {
        workId: String(token.reference?.workId ?? ''),
        title: String(token.reference?.title ?? ''),
      },
    }
  },

  renderMarkdown(node) {
    return serializeDiagramEmbed({
      workId: String(node.attrs?.workId ?? ''),
      title: String(node.attrs?.title ?? ''),
    })
  },

  renderText({ node }) {
    return serializeDiagramEmbed({
      workId: String(node.attrs?.workId ?? ''),
      title: String(node.attrs?.title ?? ''),
    })
  },

  parseHTML() {
    return [{ tag: 'div[data-diagram-embed]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-diagram-embed': node.attrs.workId,
      'data-diagram-title': node.attrs.title,
    })]
  },
})

/** An artifact work embedded on its own line: `[title](work://embed?…&type=artifact)`. */
export const ArtifactEmbed = Node.create({
  name: 'artifactEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      workId: { default: null },
      title: { default: '' },
    }
  },

  markdownTokenizer: {
    name: 'artifactEmbed',
    level: 'block',
    start: embedStart,
    tokenize(src: string) {
      const { line, raw } = firstLine(src)
      const reference = parseWorkEmbed(line)
      // The diagram tokenizer starts on `[` too. Declining the other member of
      // the family is what keeps one from swallowing the other's lines.
      if (reference?.type !== 'artifact') return undefined
      return { type: 'artifactEmbed', raw, reference }
    },
  },

  parseMarkdown(token) {
    return {
      type: 'artifactEmbed',
      attrs: {
        workId: String(token.reference?.workId ?? ''),
        title: String(token.reference?.title ?? ''),
      },
    }
  },

  renderMarkdown(node) {
    return serializeWorkEmbed({
      workId: String(node.attrs?.workId ?? ''),
      title: String(node.attrs?.title ?? ''),
      type: 'artifact',
    })
  },

  renderText({ node }) {
    return serializeWorkEmbed({
      workId: String(node.attrs?.workId ?? ''),
      title: String(node.attrs?.title ?? ''),
      type: 'artifact',
    })
  },

  parseHTML() {
    return [{ tag: 'div[data-artifact-embed]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-artifact-embed': node.attrs.workId,
      'data-artifact-title': node.attrs.title,
    })]
  },
})
