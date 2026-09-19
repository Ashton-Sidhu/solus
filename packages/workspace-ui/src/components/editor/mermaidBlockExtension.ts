import { Node, mergeAttributes } from '@tiptap/core'
import { mount, unmount } from 'svelte'
import MermaidBlockNodeView from './MermaidBlockNodeView.svelte'
import { MERMAID_SOURCE_INFO } from '../conversation/lib/mermaid-block'
import { mermaidBlockFence, serializeMermaidBlock } from './lib/mermaid-block-fence'

interface MermaidBlockExtensionOptions {
  /** The app theme, read through the shell that built this extension: a node
   *  view cannot reach the settings context itself. */
  isDark: () => boolean
}

/**
 * A ```mermaid fence in a document or plan, drawn in place.
 *
 * The node holds the Mermaid text as an attribute rather than as editable
 * content: it is one definition the renderer draws, not prose the schema
 * should be splitting into paragraphs. Its markdown never changes shape, so
 * the file stays as portable as it was before Solus opened it.
 */
export const MermaidBlockMarkdownExtension = Node.create({
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
    start: (src: string) => src.search(/(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/),
    tokenize(src: string) {
      const block = mermaidBlockFence(src)
      // Anything else — another language, a `source` fence, an unclosed fence —
      // falls through to marked's own fence rule and stays a code block.
      if (!block) return undefined
      return { type: 'mermaidBlock', raw: block.raw, source: block.source }
    },
  },

  parseMarkdown(token) {
    return {
      type: 'mermaidBlock',
      attrs: { source: String(token.source ?? '') },
    }
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

export function createMermaidBlockExtension(options: MermaidBlockExtensionOptions) {
  return MermaidBlockMarkdownExtension.extend({
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div')
        dom.className = 'doc-mermaid-block'
        const current = { source: String(node.attrs.source ?? '') }
        const component = mount(MermaidBlockNodeView, {
          target: dom,
          props: {
            source: current.source,
            isDark: options.isDark,
            // Committed on blur or Done, never per keystroke: a transaction per
            // character would redraw the diagram as fast as the reader types.
            onCommit: (source: string) => {
              const pos = getPos()
              if (pos == null || source === current.source) return
              current.source = source
              editor
                .chain()
                .command(({ tr }) => {
                  tr.setNodeAttribute(pos, 'source', source)
                  return true
                })
                .run()
            },
            onShowAsCode: () => {
              const pos = getPos()
              if (pos == null) return
              const { schema } = editor.state
              const codeBlock = schema.nodes.codeBlock?.create(
                { language: MERMAID_SOURCE_INFO },
                current.source ? schema.text(current.source) : null,
              )
              if (!codeBlock) return
              editor
                .chain()
                .focus()
                .command(({ tr }) => {
                  tr.replaceWith(pos, pos + node.nodeSize, codeBlock)
                  return true
                })
                .run()
            },
          },
        })
        return {
          dom,
          update(nextNode) {
            if (nextNode.type.name !== 'mermaidBlock') return false
            const source = String(nextNode.attrs.source ?? '')
            if (source !== current.source) {
              current.source = source
              component.setSource(source)
            }
            return true
          },
          stopEvent(event) {
            // The controls and the source editor own every pointer and key
            // event inside them. ProseMirror claiming those would turn a click
            // into a block selection and a keystroke into a document edit.
            return event.target instanceof Element && !!event.target.closest('button, textarea')
          },
          destroy() {
            void unmount(component)
          },
        }
      }
    },
  })
}
