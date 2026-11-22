import { mediaTypeFor } from '@solus/contracts/media-types'
import { refsMatchHost, type ClipboardAttachmentRef } from '@solus/client-core/attachment-clipboard'
import type { UploadedAttachment } from './attachments'

/**
 * The phone's side of a copy made on desktop or web: the clipboard's HTML
 * names host files (`@solus/client-core/attachment-clipboard`), and when this
 * session's host holds them they attach again without uploading.
 */

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
