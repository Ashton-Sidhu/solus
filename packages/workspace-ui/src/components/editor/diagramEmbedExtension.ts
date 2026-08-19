import { Node, mergeAttributes } from '@tiptap/core'
import { mount, unmount } from 'svelte'
import { parseDiagramEmbed, serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import type { Work } from '@solus/contracts/types'
import DiagramEmbedNodeView from './DiagramEmbedNodeView.svelte'

export interface DiagramEmbedChoice {
  workId: string
  title: string
  updatedAt: string
}

export interface DiagramEmbedWorkSource {
  works: Record<string, Work>
  ensureContent(workId: string, source?: string): Promise<Work | null>
}

interface DiagramEmbedExtensionOptions {
  worksStore: DiagramEmbedWorkSource
  onOpen: (workId: string) => void
}

export const DiagramEmbedMarkdownExtension = Node.create({
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
    start: (src: string) => /^\s*\[/.exec(src)?.index ?? -1,
    tokenize(src: string) {
      const newline = src.indexOf('\n')
      const line = newline === -1 ? src : src.slice(0, newline)
      const reference = parseDiagramEmbed(line)
      if (!reference) return undefined
      const raw = newline === -1 ? line : `${line}\n`
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

export function createDiagramEmbedExtension(options: DiagramEmbedExtensionOptions) {
  return DiagramEmbedMarkdownExtension.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('div')
        dom.className = 'doc-diagram-embed'
        const component = mount(DiagramEmbedNodeView, {
          target: dom,
          props: {
            workId: String(node.attrs.workId ?? ''),
            fallbackTitle: String(node.attrs.title ?? ''),
            worksStore: options.worksStore,
            onOpen: options.onOpen,
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
            return event.target instanceof Element && !!event.target.closest('button')
          },
          destroy() {
            void unmount(component)
          },
        }
      }
    },
  })
}
