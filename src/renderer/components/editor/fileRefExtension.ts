import { Node, mergeAttributes } from '@tiptap/core'
import { tokenClassName } from './tokenStyle'
import { FILE_ICON_VIEWBOX, getFileIconPath, FOLDER_ICON_PATH } from './fileIcons'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface FileRefAttrs {
  /** Full path as it should be sent to the agent (e.g. `src/foo.ts`, `~/bar`). */
  path: string
  /** Basename shown inside the token. */
  name: string
}

function basename(path: string): string {
  const stripped = path.replace(/\/+$/, '')
  const idx = stripped.lastIndexOf('/')
  return idx === -1 ? stripped : stripped.slice(idx + 1)
}

export const FileRefExtension = Node.create({
  name: 'fileReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      path: { default: '' },
      name: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-file-ref]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const isDir = node.attrs.path.endsWith('/')
    const name = node.attrs.name || basename(node.attrs.path)
    const iconPath = isDir ? FOLDER_ICON_PATH : getFileIconPath(name)

    return ['span', mergeAttributes(HTMLAttributes, {
      'data-file-ref': node.attrs.path,
      contenteditable: 'false',
      title: node.attrs.path,
      class: `${tokenClassName('file')} solus-token--input-file-ref`,
    }),
      ['span', { class: 'solus-token__icon' },
        [`${SVG_NS} svg`, { viewBox: FILE_ICON_VIEWBOX, fill: 'currentColor' },
          ['path', { d: iconPath }],
        ],
      ],
      ['span', {}, name],
    ]
  },

  renderMarkdown(node) {
    return `@${node.attrs?.path ?? ''}`
  },
})
