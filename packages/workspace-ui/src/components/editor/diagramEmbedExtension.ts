import { mount, unmount, type getAllContexts } from 'svelte'
import { DiagramEmbed } from '@solus/document-model/blocks'
import DiagramEmbedNodeView from './DiagramEmbedNodeView.svelte'
import type { WorkEmbedSource } from './lib/work-embed'

interface DiagramEmbedExtensionOptions {
  contexts: ReturnType<typeof getAllContexts>
  worksStore: WorkEmbedSource
  onOpen: (workId: string) => void
  onOpenSecondary: (workId: string) => void
}

/** An embedded diagram, drawn from its work. The node and its markdown are
 *  the document model's. */
export function createDiagramEmbedExtension(options: DiagramEmbedExtensionOptions) {
  return DiagramEmbed.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('div')
        dom.className = 'doc-diagram-embed'
        const component = mount(DiagramEmbedNodeView, {
          target: dom,
          context: options.contexts,
          props: {
            workId: String(node.attrs.workId ?? ''),
            fallbackTitle: String(node.attrs.title ?? ''),
            worksStore: options.worksStore,
            onOpen: options.onOpen,
            onOpenSecondary: options.onOpenSecondary,
          },
        })
        return {
          dom,
          update(nextNode) {
            return nextNode.type.name === 'diagramEmbed'
              && nextNode.attrs.workId === node.attrs.workId
              && nextNode.attrs.title === node.attrs.title
          },
          stopEvent(event) {
            // The embedded canvas handles its own pointer work — panning,
            // zooming, drilling. ProseMirror must not claim those events as a
            // block drag or a selection, or the graph cannot be read at all.
            return (
              event.target instanceof Element
              && !!event.target.closest('button, .diagram-embed__canvas')
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
