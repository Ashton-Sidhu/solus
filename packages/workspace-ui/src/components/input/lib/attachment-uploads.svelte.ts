import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import type { AttachmentUploadTokenResult } from '@solus/contracts/rpc'
import type { Attachment, HostCapabilities, IpcContext } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import {
  assertUploadCount,
  attachmentKind,
  attachmentUploadRoute,
  postAttachmentBytes,
  readFileDataUrl,
} from './attachment-upload'

export type AttachmentUploadState =
  | { status: 'uploading'; loadedBytes: number; totalBytes: number }
  | { status: 'failed'; message: string }

interface StreamedUpload {
  api: Pick<HostApi, 'attachUploadToken'>
  ctx: IpcContext
  origin: string
  body: Blob
  /** The live composer attachment. It is a `$state` proxy, so filling in its
   *  host path after the bytes land updates every composer that holds it. */
  attachment: Attachment
  token: AttachmentUploadTokenResult | null
  abort: AbortController | null
}

/** A retry reuses its token only while it has time left for a whole upload. */
const TOKEN_REUSE_MARGIN_MS = 60_000

/**
 * Streamed uploads in flight or failed, keyed by attachment id. The chip shows
 * progress and Retry from here; the composer refuses to send while any of its
 * attachments is listed, because a prompt must not name a file that is not on
 * the host yet.
 */
class AttachmentUploads {
  private readonly states = new SvelteMap<string, AttachmentUploadState>()
  private readonly uploads = new Map<string, StreamedUpload>()

  stateFor(attachmentId: string): AttachmentUploadState | undefined {
    return this.states.get(attachmentId)
  }

  /** Why a prompt holding these attachments cannot go yet, or null. */
  sendBlocker(attachments: Attachment[]): string | null {
    let hasFailed = false
    for (const attachment of attachments) {
      const state = this.states.get(attachment.id)
      if (state?.status === 'uploading') return 'Wait for the upload to finish.'
      if (state?.status === 'failed') hasFailed = true
    }
    return hasFailed ? 'Retry or remove the failed upload.' : null
  }

  /** Mint the upload URL, then send bytes in the background. Invalid size or
   *  context fails here; failures while sending stay on the chip for Retry. */
  async start(request: {
    api: Pick<HostApi, 'attachUploadToken'>
    ctx: IpcContext
    serverId: string
    origin: string
    file: Blob
    name: string
  }): Promise<Attachment> {
    const kind = attachmentKind({ name: request.name, mimeType: request.file.type })
    const token = await request.api.attachUploadToken(request.ctx, {
      name: request.name,
      mime: kind.mimeType,
      size: request.file.size,
    })
    const attachment = $state<Attachment>({
      id: uuid(),
      type: kind.type,
      name: request.name,
      // Nothing the agent can open yet. `path` becomes the host path when the
      // upload lands; until then the chip holds only a name.
      path: request.name,
      hostServerId: request.serverId,
      mimeType: kind.mimeType,
      size: request.file.size,
    })
    this.uploads.set(attachment.id, {
      api: request.api,
      ctx: request.ctx,
      origin: request.origin,
      body: request.file,
      attachment,
      token,
      abort: null,
    })
    void this.send(attachment.id)
    return attachment
  }

  retry(attachmentId: string): void {
    if (this.states.get(attachmentId)?.status !== 'failed') return
    void this.send(attachmentId)
  }

  /** The chip was removed: stop sending and forget it. */
  cancel(attachmentId: string): void {
    this.uploads.get(attachmentId)?.abort?.abort()
    this.uploads.delete(attachmentId)
    this.states.delete(attachmentId)
  }

  private async send(attachmentId: string): Promise<void> {
    const upload = this.uploads.get(attachmentId)
    if (!upload) return
    const totalBytes = upload.body.size
    const abort = new AbortController()
    upload.abort = abort
    this.states.set(attachmentId, { status: 'uploading', loadedBytes: 0, totalBytes })
    try {
      if (!upload.token || upload.token.expiresAt - Date.now() < TOKEN_REUSE_MARGIN_MS) {
        upload.token = await upload.api.attachUploadToken(upload.ctx, {
          name: upload.attachment.name,
          mime: upload.attachment.mimeType ?? 'application/octet-stream',
          size: totalBytes,
        })
      }
      const token = upload.token
      await postAttachmentBytes({
        url: new URL(token.relativeUrl, `${upload.origin.replace(/\/+$/, '')}/`).toString(),
        body: upload.body,
        signal: abort.signal,
        onProgress: (loadedBytes) => {
          if (this.uploads.get(attachmentId) !== upload) return
          this.states.set(attachmentId, { status: 'uploading', loadedBytes, totalBytes })
        },
      })
      if (this.uploads.get(attachmentId) !== upload) return
      upload.attachment.hostPath = token.hostPath
      upload.attachment.path = token.hostPath
      this.uploads.delete(attachmentId)
      this.states.delete(attachmentId)
    } catch (error) {
      if (this.uploads.get(attachmentId) !== upload || abort.signal.aborted) return
      // Reuse the path: the host removes partial files and acknowledges a
      // completed upload again if its first success response was lost.
      this.states.set(attachmentId, {
        status: 'failed',
        message: error instanceof Error ? error.message : 'The upload failed.',
      })
    }
  }
}

export const attachmentUploads = new AttachmentUploads()

/**
 * Attach picked or dropped files. Small files and images go through the RPC
 * as before and are ready when this resolves; videos and large files come back
 * as chips that are still uploading.
 */
export async function uploadFileObjects(
  api: HostApi,
  ctx: IpcContext,
  serverId: string,
  files: File[],
): Promise<Attachment[]> {
  assertUploadCount(files.length)
  const capabilities = await serverConnections.capabilitiesFor(serverId)
  const attachments: Attachment[] = []
  for (const file of files) {
    attachments.push(await uploadBlob(api, ctx, serverId, capabilities, file, file.name))
  }
  return attachments
}

async function uploadBlob(
  api: HostApi,
  ctx: IpcContext,
  serverId: string,
  capabilities: HostCapabilities,
  file: Blob,
  name: string,
): Promise<Attachment> {
  const kind = attachmentKind({ name, mimeType: file.type })
  // A picker that reports no type for a video still sends it as one: the data
  // URL and the upload both carry the MIME type the host is told about.
  const typed = file.type === kind.mimeType ? file : new Blob([file], { type: kind.mimeType })
  if (attachmentUploadRoute({ name, mimeType: kind.mimeType, size: file.size }, capabilities) === 'stream') {
    return attachmentUploads.start({
      api,
      ctx,
      serverId,
      origin: serverConnections.httpOriginFor(serverId),
      file: typed,
      name,
    })
  }
  const dataUrl = await readFileDataUrl(typed)
  const hostPath = await api.attachUpload(ctx, { name, mime: kind.mimeType, dataUrl })
  const attachment: Attachment = {
    id: uuid(),
    type: kind.type,
    name,
    path: hostPath,
    hostPath,
    hostServerId: serverId,
    mimeType: kind.mimeType,
    size: file.size,
  }
  if (kind.type === 'image') attachment.dataUrl = dataUrl
  return attachment
}

/**
 * Send files the desktop picked from its own disk to a remote host. A video is
 * read as a Blob through the local artifact protocol and streamed, because its
 * base64 copy would not fit the IPC read limit.
 */
export async function uploadLocalAttachments(
  api: HostApi,
  ctx: IpcContext,
  serverId: string,
  attachments: Attachment[],
  readBytes: (path: string, mime: string) => Promise<{ dataUrl: string; size: number }>,
  readBlob: (path: string) => Promise<Blob>,
): Promise<Attachment[]> {
  assertUploadCount(attachments.length)
  const capabilities = await serverConnections.capabilitiesFor(serverId)
  const uploaded: Attachment[] = []
  for (const attachment of attachments) {
    const kind = attachmentKind({ name: attachment.name, mimeType: attachment.mimeType })
    const route = attachmentUploadRoute(
      { name: attachment.name, mimeType: kind.mimeType, size: attachment.size ?? 0 },
      capabilities,
    )
    if (route === 'stream') {
      // The desktop reads only images and videos from disk as a Blob.
      if (!kind.isVideo) throw new Error('Attachments can be up to 10 MB each.')
      const blob = await readBlob(attachment.path)
      uploaded.push(await uploadBlob(api, ctx, serverId, capabilities, blob, attachment.name))
      continue
    }
    const bytes = attachment.dataUrl
      ? { dataUrl: attachment.dataUrl, size: attachment.size ?? 0 }
      : await readBytes(attachment.path, kind.mimeType)
    const hostPath = await api.attachUpload(ctx, {
      name: attachment.name,
      mime: kind.mimeType,
      dataUrl: bytes.dataUrl,
    })
    const uploadedAttachment: Attachment = {
      ...attachment,
      mimeType: kind.mimeType,
      hostPath,
      hostServerId: serverId,
      size: bytes.size,
    }
    if (attachment.type === 'image') uploadedAttachment.dataUrl = bytes.dataUrl
    uploaded.push(uploadedAttachment)
  }
  return uploaded
}
