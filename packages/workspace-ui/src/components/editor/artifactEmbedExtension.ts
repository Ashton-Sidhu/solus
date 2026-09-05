import { Node, mergeAttributes } from '@tiptap/core'
import { mount, unmount } from 'svelte'
import { parseWorkEmbed, serializeWorkEmbed } from '@solus/contracts/work-embed'
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

export const ArtifactEmbedMarkdownExtension = Node.create({
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
    start: (src: string) => /^\s*\[/.exec(src)?.index ?? -1,
    tokenize(src: string) {
      const newline = src.indexOf('\n')
      const line = newline === -1 ? src : src.slice(0, newline)
      const reference = parseWorkEmbed(line)
      // The diagram tokenizer starts on `[` too. Declining the other member of
      // the family is what keeps one from swallowing the other's lines.
      if (reference?.type !== 'artifact') return undefined
      const raw = newline === -1 ? line : `${line}\n`
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

export function createArtifactEmbedExtension(options: ArtifactEmbedExtensionOptions) {
  return ArtifactEmbedMarkdownExtension.extend({
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
