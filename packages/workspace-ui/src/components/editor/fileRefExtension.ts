import { Node, mergeAttributes } from '@tiptap/core'
import { serializeReferenceToken, type FileReferenceToken } from './reference-tokens'
import { REFERENCE_ATTRIBUTE } from './reference-clipboard'
import { fileChipParts } from '../conversation/lib/markdown-text'
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
    // The chip shows the name; a copy reads as the whole path, as a file chip
    // in a message does, so the rest of the path is copy-only text.
    const parts = fileChipParts(node.attrs.path)
    const isNameInPath = parts.label === name
    const icon = document.createElement('span')
    icon.className = 'solus-token__icon'
    icon.innerHTML = resolveFileIcon(node.attrs.path || name).svg

    return ['span', mergeAttributes(HTMLAttributes, {
      'data-file-ref': node.attrs.path,
      [REFERENCE_ATTRIBUTE]: serializeReferenceToken(fileToken(node.attrs)),
      contenteditable: 'false',
      title: node.attrs.path,
      class: tokenClassName('file'),
    }),
      icon,
      isNameInPath
        ? ['span', {}, ['span', { class: 'solus-token__copy-only' }, parts.prefix], name, ['span', { class: 'solus-token__copy-only' }, parts.suffix]]
        : ['span', {}, ['span', { class: 'solus-token__copy-only' }, node.attrs.path], ['span', { class: 'solus-token__shown-only' }, name]],
    ]
  },

  renderMarkdown(node) {
    return serializeReferenceToken(fileToken(node.attrs))
  },

  // An atom contributes nothing to a plain-text copy unless it says otherwise,
  // so a highlighted chip used to vanish from the pasted text. A copied file
  // reads as its path.
  renderText({ node }) {
    return fileToken(node.attrs).path
  },
})
