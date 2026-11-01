import { mediaTypeFor } from '@solus/contracts/media-types'
import { refsMatchHost, type ClipboardAttachmentRef } from '@solus/client-core/attachment-clipboard'
import type { UploadedAttachment } from './attachments'

/**
 * The phone's side of a copy made on desktop or web: the clipboard's HTML
 * names host files (`@solus/client-core/attachment-clipboard`), and when this
 * session's host holds them they attach again without uploading.
 */

/** One `Name.ext` or a generated label, as the copy's plain text lists them. */
const COPIED_LABEL = /^(?:Pasted (?:image|text)|[^\n,]+\.[a-z0-9]{1,8})$/i

/**
 * Whether a paste could be a Solus copy, so the clipboard's HTML is worth
 * reading. Reading it is a second clipboard access, which iOS may ask the
 * person to allow, so an ordinary text paste never pays for it.
 */
export function mayCarryAttachmentRefs(paste: { type: 'text'; value: string } | { type: 'images' } | { type: 'unsupported' }): boolean {
  if (paste.type === 'images') return true
  if (paste.type !== 'text') return false
  const labels = paste.value.trim().split(', ')
  return labels.length > 0 && labels.every((label) => COPIED_LABEL.test(label))
}

/** A phone's host ids are installation ids, so the copy's installation id is what must match. */
export function refsOnHost(refs: readonly ClipboardAttachmentRef[], hostId: string): boolean {
  return refsMatchHost(refs, { installationId: hostId })
}

/** The referenced files as the composer holds an upload: the host already has the bytes. */
export function referencedAttachments(refs: readonly ClipboardAttachmentRef[], uuid: () => string): UploadedAttachment[] {
  return refs.map((ref) => ({
    id: uuid(),
    kind: ref.type,
    name: ref.name,
    hostPath: ref.hostPath,
    mimeType: ref.mimeType ?? mediaTypeFor(ref.name)?.mime ?? 'application/octet-stream',
    size: ref.size ?? 0,
    dataUrl: null,
  }))
}

/** The draft without the copy's plain text, which the text field pasted natively. The last copy goes: it is the one just pasted. */
export function withoutPastedText(draft: string, pasted: string): string {
  const index = draft.lastIndexOf(pasted)
  return index < 0 ? draft : draft.slice(0, index) + draft.slice(index + pasted.length)
}
