import { Node, mergeAttributes } from '@tiptap/core'
import { mount, unmount } from 'svelte'
import HtmlBlockNodeView from './HtmlBlockNodeView.svelte'
import { HTML_SOURCE_INFO, htmlBlockFence, serializeHtmlBlock } from './lib/html-block-fence'

interface HtmlBlockExtensionOptions {
  /** The app theme, read through the shell that built this extension: a node
   *  view cannot reach the settings context itself. */
  isDark: () => boolean
}

/**
 * A ```html fence in a document or plan, rendered live.
 *
 * The node holds the markup as an attribute rather than as editable content:
 * it is one payload the frame runs, not prose the schema should be splitting
 * into paragraphs. Its markdown never changes shape, so the file stays as
 * portable as it was before Solus opened it.
 */
export const HtmlBlockMarkdownExtension = Node.create({
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
    start: (src: string) => src.search(/(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/),
    tokenize(src: string) {
      const block = htmlBlockFence(src)
      // Anything else — a snippet, another language, an unclosed fence — falls
      // through to marked's own fence rule and stays a code block.
      if (!block) return undefined
      return { type: 'htmlBlock', raw: block.raw, html: block.html, explicit: block.explicit }
    },
  },

  parseMarkdown(token) {
    return {
      type: 'htmlBlock',
      attrs: { html: String(token.html ?? ''), explicit: token.explicit === true },
    }
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

export function createHtmlBlockExtension(options: HtmlBlockExtensionOptions) {
  return HtmlBlockMarkdownExtension.extend({
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div')
        dom.className = 'doc-html-block'
        const current = { html: String(node.attrs.html ?? '') }
        const component = mount(HtmlBlockNodeView, {
          target: dom,
          props: {
            html: current.html,
            isDark: options.isDark,
            // Committed on blur or on the editor's own save, never per
            // keystroke: a transaction per character would re-create the frame
            // as fast as the reader types.
            onCommit: (html: string) => {
              const pos = getPos()
              if (pos == null || html === current.html) return
              current.html = html
              editor
                .chain()
                .command(({ tr }) => {
                  tr.setNodeAttribute(pos, 'html', html)
                  return true
                })
                .run()
            },
            onShowAsCode: () => {
              const pos = getPos()
              if (pos == null) return
              const { schema } = editor.state
              const codeBlock = schema.nodes.codeBlock?.create(
                { language: HTML_SOURCE_INFO },
                current.html ? schema.text(current.html) : null,
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
            if (nextNode.type.name !== 'htmlBlock') return false
            const html = String(nextNode.attrs.html ?? '')
            if (html !== current.html) {
              current.html = html
              component.setHtml(html)
            }
            return true
          },
          stopEvent(event) {
            // The render and its editor own every pointer and key event inside
            // them. ProseMirror claiming those would turn a click in the frame
            // into a block selection and a keystroke in the editor into a
            // document edit.
            return (
              event.target instanceof Element
              && !!event.target.closest('button, textarea, iframe, .artifact-frame')
            )
          },
          destroy() {
            void unmount(component)
          },
        }
      }
    },
  })
}
