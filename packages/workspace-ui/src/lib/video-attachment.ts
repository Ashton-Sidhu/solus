import type { Attachment } from '@solus/contracts/types'
import { videoMimeType } from '@solus/contracts/video'

/** A video attachment is a `file` with a video type, never an image. */
export function isVideoAttachment(attachment: Pick<Attachment, 'type' | 'name' | 'mimeType'>): boolean {
  return attachment.type === 'file' && videoMimeType({ name: attachment.name, mimeType: attachment.mimeType }) !== null
}

/**
 * The path a video attachment can be played from on its host, or null while
 * there is none: a streamed upload names only the file until its bytes land.
 * A desktop that attached a file on its own host has the absolute path only.
 */
export function videoAttachmentPath(attachment: Pick<Attachment, 'path' | 'hostPath'>): string | null {
  if (attachment.hostPath) return attachment.hostPath
  return attachment.path.startsWith('/') ? attachment.path : null
}
