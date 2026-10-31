import { Node, mergeAttributes } from '@tiptap/core'
import { serializeReferenceToken, type FileReferenceToken } from './reference-tokens'
import { tokenClassName } from './tokenStyle'
import { resolveFileIcon } from '@solus/client-core/file-icons'
import { hostPathBaseName } from '@solus/contracts/host-path'

export interface FileRefAttrs {
  /** Full path as it should be sent to the agent (e.g. `src/foo.ts`, `~/bar`). */
  path: string
  /** Basename shown inside the token. */
  name: string
}

function fileToken(attrs: Partial<FileRefAttrs> | undefined): FileReferenceToken {
  return {
    kind: 'file',
    path: attrs?.path ?? '',
    name: attrs?.name ?? '',
  }
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
    const name = node.attrs.name || hostPathBaseName(node.attrs.path)
    const icon = document.createElement('span')
    icon.className = 'solus-token__icon'
    icon.innerHTML = resolveFileIcon(node.attrs.path || name).svg

    return ['span', mergeAttributes(HTMLAttributes, {
      'data-file-ref': node.attrs.path,
      contenteditable: 'false',
      title: node.attrs.path,
      class: tokenClassName('file'),
    }),
      icon,
      ['span', {}, name],
    ]
  },

  renderMarkdown(node) {
    return serializeReferenceToken(fileToken(node.attrs))
  },

  // An atom contributes nothing to a plain-text copy unless it says otherwise,
  // so a highlighted chip used to vanish from the pasted text. Emit the same
  // canonical token the markdown serializer does.
  renderText({ node }) {
    return serializeReferenceToken(fileToken(node.attrs))
  },
})
