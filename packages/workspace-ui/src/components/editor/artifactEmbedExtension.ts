import { mount, unmount } from 'svelte'
import { ArtifactEmbed } from '@solus/document-model/blocks'
import ArtifactEmbedNodeView from './ArtifactEmbedNodeView.svelte'
import type { WorkEmbedSource } from './lib/work-embed'

interface ArtifactEmbedExtensionOptions {
  worksStore: WorkEmbedSource
  onOpen: (workId: string) => void
  onOpenSecondary: (workId: string) => void
  /** The app theme, read through the shell that built this extension: a node
   *  view cannot reach the settings context itself. */
  isDark: () => boolean
}

/** An embedded artifact, rendered from its work. The node and its markdown
 *  are the document model's. */
export function createArtifactEmbedExtension(options: ArtifactEmbedExtensionOptions) {
  return ArtifactEmbed.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('div')
        dom.className = 'doc-artifact-embed'
        const component = mount(ArtifactEmbedNodeView, {
          target: dom,
          props: {
            workId: String(node.attrs.workId ?? ''),
            fallbackTitle: String(node.attrs.title ?? ''),
            worksStore: options.worksStore,
            onOpen: options.onOpen,
            onOpenSecondary: options.onOpenSecondary,
            isDark: options.isDark,
          },
        })
        return {
          dom,
          update(nextNode) {
            return nextNode.type.name === 'artifactEmbed'
              && nextNode.attrs.workId === node.attrs.workId
              && nextNode.attrs.title === node.attrs.title
          },
          stopEvent(event) {
            // The render handles its own pointer work inside the frame — a
            // slider, a hover, a scroll. ProseMirror must not claim those as a
            // block drag or a selection, or the artifact cannot be used at all.
            return (
              event.target instanceof Element
              && !!event.target.closest('button, iframe, .artifact-frame')
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
