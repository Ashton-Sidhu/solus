import { hostPathBaseName } from '@solus/contracts/host-path'
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
  const fileName = name || (hostPathBaseName(hostPath) || hostPath).replace(UPLOAD_NAME_PREFIX, '')
  return { kind: 'file', key: `file:${index}:${hostPath}`, name: fileName, hostPath, video: videoMimeType({ name: fileName }) !== null }
}

/**
 * A sent turn split the way the bubble shows it: the typed text, and the files
 * it carried. A file exists in provider history only as the
 * `[Attached file: <path>]` lines the composer puts before the text, then a
 * blank line; without that shape the person typed the bracket themselves.
 * The desktop rule (`splitSentAttachments`), kept in step by a test.
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

/** The name the desktop composer gives a large paste (`pastedTextFile`); the desktop label rule, kept in step by a test. */
const GENERATED_PASTED_TEXT_NAME = /^pasted text \d{4}-\d{2}-\d{2} \d{6}(?: \d+)?\.txt$/i

/** What a chip or card calls a file: its name, unless Solus made the name up. */
export function attachmentDisplayName(name: string): string {
  return GENERATED_PASTED_TEXT_NAME.test(name) ? 'Pasted text' : name
}

/** A file card's second line: its type, or "Sending…" while the prompt is on its way, so the card keeps its height. */
export function attachmentCardDetail(name: string, sending: boolean): string {
  if (sending) return 'Sending…'
  return attachmentDisplayName(name) === name ? attachmentTypeLabel(name) : 'Text'
}

/**
 * How a prompt draws what it carried, as desktop does (`userMessageShape`):
 * pictures and videos as their own shape above the bubble, files as chips
 * beside the words or as cards when there are no words.
 */
export interface MessageAttachmentLayout {
  readonly images: readonly MessageAttachment[]
  readonly videos: readonly MessageAttachment[]
  readonly files: readonly MessageAttachment[]
  readonly imageLayout: 'none' | 'lone' | 'collage'
  readonly fileStyle: 'none' | 'chips' | 'cards'
  /** The bubble meets media above it, so its top-right corner tightens. */
  readonly bubbleMeetsMedia: boolean
}

export function messageAttachmentLayout(attachments: readonly MessageAttachment[], hasText: boolean): MessageAttachmentLayout {
  const images = attachments.filter((attachment) => attachment.kind !== 'file')
  const videos = attachments.filter((attachment) => attachment.kind === 'file' && attachment.video)
  const files = attachments.filter((attachment) => attachment.kind === 'file' && !attachment.video)
  return {
    images,
    videos,
    files,
    imageLayout: images.length === 0 ? 'none' : images.length === 1 ? 'lone' : 'collage',
    fileStyle: files.length === 0 ? 'none' : hasText ? 'chips' : 'cards',
    bubbleMeetsMedia: hasText && images.length + videos.length > 0,
  }
}

/**
 * The rows of a collage, by picture index: two side by side, three as a tall
 * lead beside two stacked, more in pairs with an odd last one across.
 */
export interface CollagePlan {
  /** Three pictures: the first stands tall beside the other two. */
  readonly lead: boolean
  readonly rows: readonly (readonly number[])[]
}

export function collageRows(count: number): CollagePlan {
  if (count === 3) return { lead: true, rows: [[1], [2]] }
  const rows: number[][] = []
  for (let index = 0; index < count; index += 2) rows.push(index + 1 < count ? [index, index + 1] : [index])
  return { lead: false, rows }
}

/**
 * The picture a prompt sent without words copies. The system clipboard holds
 * one image, so only a lone picture copies; videos and several pictures are
 * saved or shared from their viewer instead.
 */
export function copyableImage(attachments: readonly MessageAttachment[], hasText: boolean): MessageAttachment | null {
  if (hasText || attachments.length !== 1) return null
  const [only] = attachments
  return only && only.kind !== 'file' ? only : null
}
