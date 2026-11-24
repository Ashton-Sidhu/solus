import { hostReferenceContext } from '@solus/contracts/host-link'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import { MAX_VIDEO_UPLOAD_BYTES, attachmentKind, videoMimeType } from '@solus/contracts/media-types'
import type { IpcContext, PromptImageRef } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { EnvironmentId } from '@t3tools/contracts'
import { attachmentUploadError, createAttachmentUploadRegistry, type AttachmentUploadStatus } from '@t3tools/client-runtime/state/attachment-uploads'
import * as Effect from 'effect/Effect'

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
  /** The picked media file on this phone, for the composer's thumbnail.
   *  Never sent: the prompt names `hostPath`. */
  localUri?: string
  pending?: {
    keep(): Promise<UploadedAttachment>
    discard(): Promise<void>
  }
}

/** Reading and sending the picked bytes; the Expo adapter is `platform/expo.ts`. */
export interface AttachmentIo {
  readBase64(uri: string): Promise<string>
  /** POSTs the file's raw bytes; answers the HTTP status. */
  uploadFile(url: string, uri: string, transfer?: AttachmentTransfer): Promise<number>
  manageUpload?(url: string, method: 'HEAD' | 'POST' | 'DELETE'): Promise<number>
}

interface AttachmentTransfer {
  signal: AbortSignal
  reportProgress: (progress: number) => void
}

interface AttachmentUploadJob {
  id: string
  environmentId: EnvironmentId
  transfer: (control: AttachmentTransfer) => Promise<string>
}

const transferListeners = new Set<() => void>()
let transferStatuses: Readonly<Record<string, AttachmentUploadStatus>> = {}
const transfers = createAttachmentUploadRegistry<AttachmentUploadJob>({
  key: (job) => JSON.stringify([job.environmentId, job.id]),
  environmentId: (job) => job.environmentId,
  concurrencyPerEnvironment: 3,
  upload: (job, reportProgress) => Effect.tryPromise({
    try: (signal) => job.transfer({ signal, reportProgress }),
    catch: attachmentUploadError,
  }),
  onChange: (statuses) => {
    transferStatuses = statuses
    for (const listener of transferListeners) listener()
  },
})

export function subscribeAttachmentTransfers(listener: () => void): () => void {
  transferListeners.add(listener)
  return () => { transferListeners.delete(listener) }
}

export function attachmentTransferProgress(hostId: string, attachmentId: string): number | undefined {
  const status = transferStatuses[JSON.stringify([hostId, attachmentId])]
  return status?.status === 'uploading' && status.progress > 0 ? status.progress : undefined
}

export interface AttachmentUploadDeps {
  api: Pick<HostApi, 'attachUpload' | 'attachUploadToken'>
  ctx: IpcContext
  serverUrl: string
  io: AttachmentIo
  uuid(): string
  streamImages?: boolean
  hostId?: string
  signal?: AbortSignal
  checkAccess?: () => void
  stage?: boolean
}

/** Why these files cannot join the prompt, or null when they can. */
export function attachmentSizeProblem(files: readonly PickedFile[]): string | null {
  for (const file of files) {
    const video = videoMimeType({ name: file.name, mimeType: file.mimeType ?? '' })
    const limit = video ? MAX_VIDEO_UPLOAD_BYTES : MAX_ATTACHMENT_UPLOAD_BYTES
    if (file.size !== null && file.size > limit) return `${file.name} is larger than ${Math.round(limit / (1024 * 1024))} MB.`
  }
  return null
}

export async function uploadAttachment(file: PickedFile, deps: AttachmentUploadDeps): Promise<UploadedAttachment> {
  const kind = attachmentKind({ name: file.name, mimeType: file.mimeType })
  const video = kind.isVideo
  const mime = kind.mimeType
  const isImage = kind.type === 'image'
  const id = deps.uuid()
  let dataUrl: string | null = null
  let pendingUrl: string | undefined
  const transfer = (control: AttachmentTransfer) => {
    checkTransfer(deps, control)
    const inlineUpload = async () => {
      // The host takes standard base64 with no line breaks.
      dataUrl = `data:${mime};base64,${(await deps.io.readBase64(file.uri)).replace(/\s+/g, '')}`
      checkTransfer(deps, control)
      return deps.api.attachUpload(deps.ctx, { name: file.name, mime, dataUrl })
    }
    return video || (isImage && deps.streamImages && file.size !== null && file.size > 0)
      ? streamUpload(file, mime, deps, inlineUpload, control, (url) => { pendingUrl = url })
      : inlineUpload()
  }
  const hostPath = await Effect.runPromise(
    transfers.upload({ id, environmentId: EnvironmentId.make(deps.hostId ?? deps.serverUrl), transfer }),
    { signal: deps.signal },
  )
  const uploaded: UploadedAttachment = {
    id,
    kind: isImage ? 'image' : 'file',
    name: file.name,
    hostPath,
    mimeType: mime,
    size: file.size ?? 0,
    dataUrl: isImage ? dataUrl : null,
    localUri: file.uri,
  }
  const manage = deps.io.manageUpload
  if (pendingUrl && manage) {
    const url = pendingUrl
    uploaded.pending = {
      async keep() {
        deps.checkAccess?.()
        const status = await manage(url, 'POST')
        if (status === 403 || status === 404)
          return uploadAttachment(file, { ...deps, stage: false, uuid: () => id })
        if (status !== 204) throw new Error(`The host could not keep ${file.name} (${status}).`)
        const { pending: _pending, ...kept } = uploaded
        return kept
      },
      async discard() { await manage(url, 'DELETE') },
    }
  }
  return uploaded
}

function checkTransfer(deps: AttachmentUploadDeps, control: AttachmentTransfer): void {
  if (control.signal.aborted) throw new Error('Upload cancelled.')
  deps.checkAccess?.()
}

/** Raw file bytes over HTTP, with the RPC fallback for hosts without upload tokens. */
async function streamUpload(
  file: PickedFile,
  mime: string,
  deps: AttachmentUploadDeps,
  inlineUpload: () => Promise<string>,
  control: AttachmentTransfer,
  onPending: (url: string) => void,
): Promise<string> {
  if (file.size === null) throw new Error(`The size of ${file.name} is unknown.`)
  let token: Awaited<ReturnType<HostApi['attachUploadToken']>>
  try {
    token = await deps.api.attachUploadToken(deps.ctx, {
      name: file.name, mime, size: file.size,
      ...(deps.stage && deps.io.manageUpload && { pending: true }),
    })
  } catch (error) {
    checkTransfer(deps, control)
    if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) throw error
    return inlineUpload()
  }
  const base = `${deps.serverUrl.replace(/\/+$/, '')}/`
  const pendingUrl = token.pendingUrl && new URL(token.pendingUrl, base).toString()
  const manage = deps.io.manageUpload
  try {
    checkTransfer(deps, control)
    try {
      const status = await deps.io.uploadFile(new URL(token.relativeUrl, base).toString(), file.uri, control)
      if (status < 200 || status >= 300) throw new Error(`The host refused ${file.name} (${status}).`)
    } catch (error) {
      checkTransfer(deps, control)
      if (!pendingUrl || !manage || await manage(pendingUrl, 'HEAD') !== 204) throw error
    }
    checkTransfer(deps, control)
    if (pendingUrl) onPending(pendingUrl)
    return token.hostPath
  } catch (error) {
    if (pendingUrl && manage) void manage(pendingUrl, 'DELETE').catch(() => {})
    throw error
  }
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
  // A host chip in the text gets the same note for the agent as on desktop (host-fleet.md D12).
  const hostContext = hostReferenceContext(text)
  const typed = hostContext ? `${text}\n\n${hostContext}` : text
  const prompt = files.length
    ? `${files.map((attachment) => `[Attached file: ${attachment.hostPath}]`).join('\n')}\n\n${typed}`
    : typed
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
