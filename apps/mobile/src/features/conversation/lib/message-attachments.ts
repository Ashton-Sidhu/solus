import { videoMimeType } from '@solus/contracts/media-types'
import type { PromptImageRef } from '@solus/contracts/types'
import type { QueueAttachment } from '@solus/contracts/session-queue'
import type { UploadedAttachment } from './attachments'

/**
 * What a sent prompt carried, as a bubble shows it. Images come as bytes (the
 * composing client, or history) or as a path on the session's host; a file is
 * only ever a host path, which the phone opens through the host and never
 * reads itself. Same sources the desktop bubble reads (`session.utils.ts`).
 */
export type MessageAttachment =
  | { readonly kind: 'image'; readonly key: string; readonly name: string; readonly dataUrl: string }
  | { readonly kind: 'host-image'; readonly key: string; readonly name: string; readonly hostPath: string }
  | { readonly kind: 'file'; readonly key: string; readonly name: string; readonly hostPath: string; readonly video: boolean }

const ATTACHED_FILE_LINE = /^\[Attached file: (.+)\]$/
/** The slot and random prefix the host puts before an uploaded file's name. */
const UPLOAD_NAME_PREFIX = /^\d+-[0-9a-f]{12}-/

function fileAttachment(hostPath: string, index: number, name?: string): MessageAttachment {
  const fileName = name || (hostPath.split(/[\\/]/).pop() || hostPath).replace(UPLOAD_NAME_PREFIX, '')
  return { kind: 'file', key: `file:${index}:${hostPath}`, name: fileName, hostPath, video: videoMimeType({ name: fileName }) !== null }
}

/**
 * A sent turn split the way the bubble shows it: the typed text, and the files
 * it carried. A file exists in provider history only as the
 * `[Attached file: <path>]` lines the composer puts before the text, then a
 * blank line; without that shape the person typed the bracket themselves.
 * The desktop rule (`splitAttachedFiles`), kept in step by a test.
 */
export interface SentPromptParts {
  readonly text: string
  readonly files: MessageAttachment[]
}

export function splitAttachedFiles(content: string): SentPromptParts {
  const lines = content.split('\n')
  const paths: string[] = []
  while (paths.length < lines.length) {
    const match = ATTACHED_FILE_LINE.exec(lines[paths.length]!)
    if (!match) break
    paths.push(match[1]!)
  }
  const isComposed = paths.length > 0 && (paths.length === lines.length || lines[paths.length] === '')
  if (!isComposed) return { text: content, files: [] }
  return {
    text: lines.slice(paths.length).join('\n').replace(/^\n+/, ''),
    files: paths.map((path, index) => fileAttachment(path, index)),
  }
}

/** Images a prompt carried: inline bytes, or refs to the host's own copies. */
export function promptImageAttachments(
  inline: ReadonlyArray<{ mimeType: string; dataUrl: string }> | undefined,
  refs: readonly PromptImageRef[] | undefined,
): MessageAttachment[] {
  return [
    ...(inline ?? []).map((image, index): MessageAttachment => ({ kind: 'image', key: `image:${index}`, name: `Image ${index + 1}`, dataUrl: image.dataUrl })),
    ...(refs ?? []).map((ref, index): MessageAttachment => ({ kind: 'host-image', key: `ref:${index}:${ref.hostPath}`, name: ref.name || `Image ${index + 1}`, hostPath: ref.hostPath })),
  ]
}

/** A prompt this phone sent: its uploads, before the host echoes them. */
export function uploadedMessageAttachments(uploads: readonly UploadedAttachment[]): MessageAttachment[] {
  return uploads.map((upload, index): MessageAttachment =>
    upload.kind === 'image'
      ? upload.dataUrl
        ? { kind: 'image', key: `upload:${upload.id}`, name: upload.name, dataUrl: upload.dataUrl }
        : { kind: 'host-image', key: `upload:${upload.id}`, name: upload.name, hostPath: upload.hostPath }
      : fileAttachment(upload.hostPath, index, upload.name))
}

/** A prompt waiting in the outbox across a restart: the images it sends, and
 *  the files its queue entry names on the host. */
export function queuedMessageAttachments(payload: {
  readonly imageAttachments?: ReadonlyArray<{ mimeType: string; dataUrl: string }>
  readonly imageAttachmentRefs?: readonly PromptImageRef[]
  readonly queueAttachments?: readonly QueueAttachment[]
} | undefined): MessageAttachment[] {
  if (!payload) return []
  const files = (payload.queueAttachments ?? []).flatMap((attachment, index) =>
    attachment.type === 'file' && attachment.hostPath ? [fileAttachment(attachment.hostPath, index, attachment.name)] : [])
  return [...promptImageAttachments(payload.imageAttachments, payload.imageAttachmentRefs), ...files]
}

/** The short type a file card names, as T3 does: PDF, the extension, or File. */
export function attachmentTypeLabel(name: string): string {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toUpperCase()
  return extension ?? 'File'
}
