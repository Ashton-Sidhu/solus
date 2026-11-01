import type { Attachment } from '@solus/contracts/types'
import { attachmentClipboardHtml, type ClipboardAttachmentRef } from '@solus/client-core/attachment-clipboard'

/** A reference attached again: the host already holds the bytes, so the
 *  attachment carries its path and nothing has to upload. */
export function reattachedAttachment(ref: ClipboardAttachmentRef, id: string): Attachment {
  const attachment: Attachment = {
    id,
    type: ref.type,
    name: ref.name,
    path: ref.hostPath,
    hostPath: ref.hostPath,
    hostServerId: ref.hostServerId,
  }
  if (ref.mimeType) attachment.mimeType = ref.mimeType
  if (ref.size !== undefined) attachment.size = ref.size
  return attachment
}

/** A picture as PNG, the one image type the clipboard takes everywhere. */
async function pngBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`The host answered ${response.status}.`)
  const blob = await response.blob()
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve, reject) => {
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('The picture could not be encoded.'))), 'image/png')
  })
}

/**
 * Write the copy. The clipboard item is built at once, with the picture as a
 * pending blob: Safari refuses a write that starts after an await, because the
 * click that asked for it no longer counts. When the picture cannot be read,
 * the reference alone still goes on the clipboard.
 */
export async function writeAttachmentClipboard(input: {
  refs: readonly ClipboardAttachmentRef[]
  label: string
  /** A lone picture's URL; its bytes go on the clipboard as PNG. */
  imageUrl: Promise<string> | null
}): Promise<void> {
  const html = new Blob([attachmentClipboardHtml(input.refs, input.label)], { type: 'text/html' })
  const text = new Blob([input.label], { type: 'text/plain' })
  if (!input.imageUrl) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': text })])
    return
  }
  try {
    const png = input.imageUrl.then(pngBlob)
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': text, 'image/png': png })])
  } catch {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': text })])
  }
}
