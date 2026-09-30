import { mount, unmount } from 'svelte'
import { HtmlBlock } from '@solus/document-model/blocks'
import { HTML_SOURCE_INFO } from '@solus/document-model/fences'
import HtmlBlockNodeView from './HtmlBlockNodeView.svelte'

interface HtmlBlockExtensionOptions {
  /** The app theme, read through the shell that built this extension: a node
   *  view cannot reach the settings context itself. */
  isDark: () => boolean
}

/** A ```html fence rendered live. The node and its markdown are the
 *  document model's; this adds the frame and its source editor. */
export function createHtmlBlockExtension(options: HtmlBlockExtensionOptions) {
  return HtmlBlock.extend({
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
