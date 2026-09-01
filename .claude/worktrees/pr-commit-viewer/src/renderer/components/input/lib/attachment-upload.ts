import type { HostApi } from '@client-core/host-api'
import type { Attachment, IpcContext } from '../../../../shared/types'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENT_UPLOAD_COUNT,
} from '../../../../shared/rpc'

function assertUploadCount(count: number): void {
  if (count > MAX_ATTACHMENT_UPLOAD_COUNT) {
    throw new Error(`Attach up to ${MAX_ATTACHMENT_UPLOAD_COUNT} files at a time.`)
  }
}

function assertUploadSize(size: number): void {
  if (size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error('Attachments can be up to 10 MB each.')
  }
}

export function readFileDataUrl(file: Blob): Promise<string> {
  assertUploadSize(file.size)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Unable to read attachment.'))
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment.'))
    reader.readAsDataURL(file)
  })
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export async function uploadFileObjects(
  api: HostApi,
  ctx: IpcContext,
  serverId: string,
  files: File[],
): Promise<Attachment[]> {
  assertUploadCount(files.length)
  const attachments: Attachment[] = []
  for (const file of files) {
    const mime = file.type || 'application/octet-stream'
    const dataUrl = await readFileDataUrl(file)
    const hostPath = await api.attachUpload(ctx, { name: file.name, mime, dataUrl })
    attachments.push({
      id: crypto.randomUUID(),
      type: isImageMime(mime) ? 'image' : 'file',
      name: file.name,
      path: hostPath,
      hostPath,
      hostServerId: serverId,
      mimeType: mime,
      ...(isImageMime(mime) ? { dataUrl } : {}),
      size: file.size,
    })
  }
  return attachments
}

export async function uploadLocalAttachments(
  api: HostApi,
  ctx: IpcContext,
  serverId: string,
  attachments: Attachment[],
  readBytes: (path: string, mime: string) => Promise<{ dataUrl: string; size: number }>,
): Promise<Attachment[]> {
  assertUploadCount(attachments.length)
  const uploaded: Attachment[] = []
  for (const attachment of attachments) {
    const mime = attachment.mimeType || 'application/octet-stream'
    const bytes = attachment.dataUrl
      ? { dataUrl: attachment.dataUrl, size: attachment.size ?? 0 }
      : await readBytes(attachment.path, mime)
    assertUploadSize(bytes.size)
    const hostPath = await api.attachUpload(ctx, {
      name: attachment.name,
      mime,
      dataUrl: bytes.dataUrl,
    })
    uploaded.push({
      ...attachment,
      hostPath,
      hostServerId: serverId,
      ...(attachment.type === 'image' ? { dataUrl: bytes.dataUrl } : {}),
      size: bytes.size,
    })
  }
  return uploaded
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
    id: crypto.randomUUID(),
    type: 'image',
    name,
    path: name,
    hostServerId: serverId,
    mimeType: mime,
    dataUrl,
    size,
  }
}
