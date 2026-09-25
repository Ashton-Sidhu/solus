import type { HostApi } from '@solus/client-core/host-api'
import type { Attachment, HostCapabilities, IpcContext } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENT_UPLOAD_COUNT,
} from '@solus/contracts/rpc'
import { MAX_VIDEO_UPLOAD_BYTES, videoMimeType } from '@solus/contracts/video'
import { z } from 'zod'

export function assertUploadCount(count: number): void {
  if (count > MAX_ATTACHMENT_UPLOAD_COUNT) {
    throw new Error(`Attach up to ${MAX_ATTACHMENT_UPLOAD_COUNT} files at a time.`)
  }
}

function assertUploadSize(size: number): void {
  if (size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error('Attachments can be up to 10 MB each.')
  }
}

/** What a picked file is, read the same way on every client: a video is a
 *  `file` attachment with its video MIME type, never an image. */
export interface AttachmentKind {
  type: 'image' | 'file'
  mimeType: string
  isVideo: boolean
}

export function attachmentKind(file: { name: string; mimeType?: string | null }): AttachmentKind {
  const video = videoMimeType(file)
  if (video) return { type: 'file', mimeType: video, isVideo: true }
  const mimeType = file.mimeType || 'application/octet-stream'
  return { type: isImageMime(mimeType) ? 'image' : 'file', mimeType, isVideo: false }
}

/**
 * How one file reaches the host. `rpc` sends base64 through `attachUpload`,
 * which is limited to 10 MB. `stream` sends the raw bytes over HTTP with a
 * token from `attachUploadToken`; every video takes it, so a phone does not
 * hold a base64 copy of a recording in memory. A host that cannot take a
 * stream keeps the old limit, and the error says what to do about it.
 */
export function attachmentUploadRoute(
  file: { name: string; mimeType?: string | null; size: number },
  capabilities: Pick<HostCapabilities, 'attachStreamUpload'>,
): 'rpc' | 'stream' {
  const { isVideo } = attachmentKind(file)
  if (isVideo && file.size > MAX_VIDEO_UPLOAD_BYTES) {
    throw new Error(`Videos can be up to ${MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024} MB.`)
  }
  // Only videos may exceed 10 MB; the host refuses any other large file.
  if (!isVideo && file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error('Files other than videos can be up to 10 MB.')
  }
  if (!isVideo) return 'rpc'
  if (capabilities.attachStreamUpload === true) return 'stream'
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error('Update the host to attach videos larger than 10 MB.')
  }
  return 'rpc'
}

/** Send one file's bytes to a streamed-upload URL. XHR, not fetch: only XHR
 *  reports upload progress. The token in the URL is the only credential. */
export function postAttachmentBytes(request: {
  url: string
  body: Blob
  onProgress: (loadedBytes: number) => void
  signal: AbortSignal
}): Promise<void> {
  if (request.signal.aborted) return Promise.reject(new DOMException('The upload was cancelled.', 'AbortError'))
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    const settle = () => request.signal.removeEventListener('abort', abort)
    xhr.upload.onprogress = (event) => request.onProgress(event.loaded)
    xhr.onload = () => {
      settle()
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(xhr.responseText.trim() || `The upload failed (${xhr.status}).`))
    }
    xhr.onerror = () => {
      settle()
      reject(new Error('The upload lost its connection to the host.'))
    }
    xhr.onabort = () => {
      settle()
      reject(new DOMException('The upload was cancelled.', 'AbortError'))
    }
    xhr.open('POST', request.url)
    xhr.send(request.body)
  })
}

export function readFileDataUrl(file: Blob): Promise<string> {
  assertUploadSize(file.size)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = z.string().safeParse(reader.result)
      if (result.success) resolve(result.data)
      else reject(new Error('Unable to read attachment.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment.'))
    reader.readAsDataURL(file)
  })
}

/**
 * Text at or above this many bytes is filed rather than typed into the
 * composer. A paste this large stalls the editor while it parses, and it
 * enters the window as context whether or not the agent needs all of it —
 * as a file the agent reads only the part it asks for.
 */
export const LARGE_PASTE_MIN_BYTES = 32 * 1024

/**
 * Cheap lower bound before measuring: one UTF-16 code unit encodes to at most
 * three UTF-8 bytes, so anything shorter than this cannot reach the threshold
 * and never pays for the encode.
 */
const LARGE_PASTE_MIN_CHARS = Math.ceil(LARGE_PASTE_MIN_BYTES / 3)

/** Whether a pasted string is big enough to file instead of type. */
export function isLargePaste(text: string): boolean {
  if (text.length < LARGE_PASTE_MIN_CHARS) return false
  return new TextEncoder().encode(text).length >= LARGE_PASTE_MIN_BYTES
}

/**
 * The pasted text as a file the agent can open. Named for what it is, because
 * the name is all the composer chip and the agent's directory listing show.
 */
export function pastedTextFile(text: string, now = new Date()): File {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return new File([text], `pasted text ${stamp} ${time}.txt`, { type: 'text/plain' })
}

/** The part of a clipboard entry the composer reads. */
export interface ClipboardImageItem {
  type: string
  getAsFile(): File | null
}

/** The part of a paste's `clipboardData` the composer reads. */
export interface ComposerClipboard {
  items?: Iterable<ClipboardImageItem> | null
  files?: Iterable<File> | null
}

/** Every image and video on the clipboard, in order. A paste can carry more
 *  than one.
 *  Both lists are read because neither is complete on its own: iOS Safari hands
 *  a screenshot or a photo over in `files` while leaving `items` empty, so a
 *  phone paste attaches nothing when only `items` is consulted. A desktop
 *  browser reports the same image in both, and the repeat is dropped.
 *  `getAsFile` only answers while the event is live, so the blobs are taken
 *  before the first upload awaits. */
export function clipboardMedia(clipboard: ComposerClipboard): File[] {
  const images = Array.from(clipboard.items ?? [])
    .filter((item) => isImageMime(item.type) || item.type.startsWith('video/'))
    .map((item) => item.getAsFile())
    .filter((blob): blob is File => !!blob)
  for (const file of clipboard.files ?? []) {
    if (!isImageMime(file.type) && !videoMimeType({ name: file.name, mimeType: file.type })) continue
    const alreadyTaken = images.some(
      (seen) => seen.name === file.name && seen.size === file.size && seen.type === file.type,
    )
    if (!alreadyTaken) images.push(file)
  }
  return images
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export async function uploadPastedImage(
  api: HostApi,
  ctx: IpcContext,
  serverId: string,
  dataUrl: string,
): Promise<Attachment> {
  const attachment = pastedImageAttachment(dataUrl, serverId)
  const hostPath = await api.attachUpload(ctx, {
    name: attachment.name,
    mime: attachment.mimeType || 'image/png',
    dataUrl,
  })
  return { ...attachment, path: hostPath, hostPath }
}

/** Images can still travel as prompt content when an older host cannot mint a
 * host-side attachment path. File attachments cannot use this fallback. */
export function pastedImageAttachment(dataUrl: string, serverId: string): Attachment {
  const match = dataUrl.match(/^data:(image\/([a-z0-9.+-]+));base64,/i)
  if (!match) throw new Error('The pasted image is invalid.')
  const mime = match[1]
  const extension = match[2] === 'jpeg' ? 'jpg' : match[2]
  const size = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4)
  assertUploadSize(size)
  const name = `pasted image.${extension}`
  return {
    id: uuid(),
    type: 'image',
    name,
    path: name,
    hostServerId: serverId,
    mimeType: mime,
    dataUrl,
    size,
  }
}

/** Whole percent sent, for the chip. Never 100 before the host has answered:
 *  the last byte leaving the client is not the file being on the host. */
export function uploadProgressPercent(loadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0
  return Math.min(99, Math.floor((loadedBytes / totalBytes) * 100))
}
