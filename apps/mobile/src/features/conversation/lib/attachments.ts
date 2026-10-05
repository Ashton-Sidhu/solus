import { MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { MAX_VIDEO_UPLOAD_BYTES, videoMimeType } from '@solus/contracts/media-types'
import type { IpcContext, PromptImageRef } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'

/**
 * Attachments from the phone, uploaded to the session's host the way the web
 * client does it (`ws-browser-api.ts`, `prompt-composer.ts`). A phone's file
 * path is never sent as a host path: the bytes go to the host, and the prompt
 * names the path the host stored them at.
 */

/** A file the person picked, as the platform picker reports it. */
export interface PickedFile {
  uri: string
  name: string
  mimeType: string | null
  size: number | null
}

export interface UploadedAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  hostPath: string
  mimeType: string
  size: number
  /** Images only: the bytes as a data URL, for a host that cannot read refs. */
  dataUrl: string | null
}

/** Reading and sending the picked bytes; the Expo adapter is `platform/expo.ts`. */
export interface AttachmentIo {
  readBase64(uri: string): Promise<string>
  /** POSTs the file's raw bytes; answers the HTTP status. */
  uploadFile(url: string, uri: string): Promise<number>
}

export interface AttachmentUploadDeps {
  api: Pick<HostApi, 'attachUpload' | 'attachUploadToken'>
  ctx: IpcContext
  serverUrl: string
  io: AttachmentIo
  uuid(): string
}

export class AttachmentRefusedError extends Error {}

/** Why these files cannot join the prompt, or null when they can. */
export function attachmentLimitProblem(files: readonly PickedFile[], alreadyAttached: number): string | null {
  if (files.length + alreadyAttached > MAX_ATTACHMENT_UPLOAD_COUNT) return `A message can carry up to ${MAX_ATTACHMENT_UPLOAD_COUNT} attachments.`
  for (const file of files) {
    const video = videoMimeType({ name: file.name, mimeType: file.mimeType ?? '' })
    const limit = video ? MAX_VIDEO_UPLOAD_BYTES : MAX_ATTACHMENT_UPLOAD_BYTES
    if (file.size !== null && file.size > limit) return `${file.name} is larger than ${Math.round(limit / (1024 * 1024))} MB.`
  }
  return null
}

export async function uploadAttachment(file: PickedFile, deps: AttachmentUploadDeps): Promise<UploadedAttachment> {
  const video = videoMimeType({ name: file.name, mimeType: file.mimeType ?? '' })
  const mime = video ?? (file.mimeType || 'application/octet-stream')
  const isImage = !video && mime.startsWith('image/')
  let hostPath: string
  let dataUrl: string | null = null
  if (video) {
    hostPath = await streamUpload(file, mime, deps)
  } else {
    // The host takes standard base64 with no line breaks.
    dataUrl = `data:${mime};base64,${(await deps.io.readBase64(file.uri)).replace(/\s+/g, '')}`
    hostPath = await deps.api.attachUpload(deps.ctx, { name: file.name, mime, dataUrl })
  }
  return {
    id: deps.uuid(),
    kind: isImage ? 'image' : 'file',
    name: file.name,
    hostPath,
    mimeType: mime,
    size: file.size ?? 0,
    dataUrl: isImage ? dataUrl : null,
  }
}

/** A video's raw bytes over HTTP to a signed upload URL; a host too old to
 *  mint one still takes a video within the RPC limit. */
async function streamUpload(file: PickedFile, mime: string, deps: AttachmentUploadDeps): Promise<string> {
  if (file.size === null) throw new AttachmentRefusedError(`The size of ${file.name} is unknown.`)
  let token: Awaited<ReturnType<HostApi['attachUploadToken']>>
  try {
    token = await deps.api.attachUploadToken(deps.ctx, { name: file.name, mime, size: file.size })
  } catch (error) {
    if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) throw error
    const dataUrl = `data:${mime};base64,${(await deps.io.readBase64(file.uri)).replace(/\s+/g, '')}`
    return deps.api.attachUpload(deps.ctx, { name: file.name, mime, dataUrl })
  }
  const status = await deps.io.uploadFile(new URL(token.relativeUrl, `${deps.serverUrl.replace(/\/+$/, '')}/`).toString(), file.uri)
  if (status < 200 || status >= 300) throw new AttachmentRefusedError(`The host refused ${file.name} (${status}).`)
  return token.hostPath
}

export interface ComposedPrompt {
  prompt: string
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
  imageAttachmentRefs?: PromptImageRef[]
}

/**
 * The prompt the host runs: non-image files are named before the text by
 * their host path; images travel as host refs, or inline for a host that
 * cannot read refs (`promptImageRefs`).
 */
export function composePrompt(text: string, attachments: readonly UploadedAttachment[], hostReadsImageRefs: boolean): ComposedPrompt {
  const files = attachments.filter((attachment) => attachment.kind === 'file')
  const prompt = files.length
    ? `${files.map((attachment) => `[Attached file: ${attachment.hostPath}]`).join('\n')}\n\n${text}`
    : text
  const composed: ComposedPrompt = { prompt }
  const refs: PromptImageRef[] = []
  const inline: Array<{ mimeType: string; dataUrl: string }> = []
  for (const image of attachments) {
    if (image.kind !== 'image') continue
    if (hostReadsImageRefs) refs.push({ mimeType: image.mimeType, hostPath: image.hostPath, name: image.name })
    else if (image.dataUrl) inline.push({ mimeType: image.mimeType, dataUrl: image.dataUrl })
  }
  if (refs.length) composed.imageAttachmentRefs = refs
  if (inline.length) composed.imageAttachments = inline
  return composed
}
