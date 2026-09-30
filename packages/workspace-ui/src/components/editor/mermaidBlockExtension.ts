import { mount, unmount } from 'svelte'
import { MermaidBlock } from '@solus/document-model/blocks'
import { MERMAID_SOURCE_INFO } from '@solus/document-model/fences'
import MermaidBlockNodeView from './MermaidBlockNodeView.svelte'

interface MermaidBlockExtensionOptions {
  /** The app theme, read through the shell that built this extension: a node
   *  view cannot reach the settings context itself. */
  isDark: () => boolean
}

/** A ```mermaid fence drawn in place. The node and its markdown are the
 *  document model's; this adds the drawing and its source editor. */
export function createMermaidBlockExtension(options: MermaidBlockExtensionOptions) {
  return MermaidBlock.extend({
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
