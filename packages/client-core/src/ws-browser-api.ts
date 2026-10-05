import { MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { MAX_VIDEO_UPLOAD_BYTES, videoMimeType } from '@solus/contracts/media-types'
import { uuid } from '@solus/contracts/uuid'
import type { Attachment, IpcContext } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import { pickFiles } from './file-picker'
import type { WsTransport } from './ws-transport'

/**
 * The browser window's part of a `window.solus`-compatible API: visibility,
 * links, and file selection belong to the device the user holds, not to the
 * host. The native mobile client supplies its own equivalents instead.
 */
export function withBrowserCapabilities<Api extends object>(
  api: Api,
  transport: WsTransport,
  options: { useHostFileDialog?: boolean } = {},
): Api {
  const browser = {
    getPlatform: () => 'web',
    getPathForFile: () => '',
    setQuoteContext: () => {},
    onQuoteSelection: () => () => {},
    onAskSelectionInNewSession: () => () => {},
    onOpenSelectedLink: () => () => {},
  }
  for (const [name, value] of Object.entries(browser)) {
    if (!Reflect.has(api, name)) Reflect.set(api, name, value)
  }

  // Visibility belongs to the client window. Asking the selected host would
  // fail for a remote web connection and would describe the wrong machine.
  Reflect.set(api, 'isVisible', (): Promise<boolean> =>
    Promise.resolve(document.visibilityState === 'visible'))

  // A link must open on the device the user is holding — the RPC would open
  // a browser on the host instead (e.g. provider sign-in verification URLs).
  Reflect.set(api, 'openExternal', (url: string): Promise<boolean> => {
    window.open(url, '_blank', 'noopener')
    return Promise.resolve(true)
  })

  // Keep the local desktop's native picker/path fast path. Browser clients and
  // remote desktop targets select File objects and upload bytes instead.
  if (!options.useHostFileDialog) {
    Reflect.set(api, 'attachFiles', async (ctx?: IpcContext): Promise<Attachment[] | null> => {
      if (!ctx) return null
      const files = await pickFiles()
      return files.length === 0 ? null : uploadFiles(transport, files, ctx)
    })
  }
  Reflect.set(api, 'uploadFiles', (files: File[], ctx: IpcContext): Promise<Attachment[] | null> => uploadFiles(transport, files, ctx))
  return api
}

function readFileDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => reader.result instanceof ArrayBuffer
      ? reject(new Error('Unable to read attachment.'))
      : resolve(reader.result ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment.'))
    reader.readAsDataURL(file)
  })
}

async function uploadFiles(transport: WsTransport, files: File[], ctx: IpcContext): Promise<Attachment[] | null> {
  if (files.length > MAX_ATTACHMENT_UPLOAD_COUNT) return null
  try {
    const attachments: Attachment[] = []
    for (const file of files) {
      const videoMime = videoMimeType({ name: file.name, mimeType: file.type })
      if (file.size > (videoMime ? MAX_VIDEO_UPLOAD_BYTES : MAX_ATTACHMENT_UPLOAD_BYTES)) return null
      const mime = videoMime ?? (file.type || 'application/octet-stream')
      // The declared type and the bytes' type must agree for the host.
      const body = file.type === mime ? file : new Blob([file], { type: mime })
      const isImage = !videoMime && mime.startsWith('image/')
      const dataUrl = videoMime ? null : await readFileDataUrl(body)
      const hostPath = dataUrl === null
        ? await streamUpload(transport, file.name, body, ctx)
        : await transport.invoke('attachUpload', [ctx, { name: file.name, mime, dataUrl }])
      // A phone reaches a LAN host over plain HTTP, where the browser withholds
      // `crypto.randomUUID`; the shared helper falls back instead of throwing.
      const attachment: Attachment = {
        id: uuid(),
        type: isImage ? 'image' : 'file',
        name: file.name,
        path: hostPath,
        hostPath,
        mimeType: mime,
        size: file.size,
      }
      if (transport.serverId) attachment.hostServerId = transport.serverId
      if (isImage && dataUrl) attachment.dataUrl = dataUrl
      attachments.push(attachment)
    }
    return attachments
  } catch {
    return null
  }
}

/** Send a video's raw bytes over HTTP. Base64 in a socket frame cannot carry
 *  one. Signed upload URLs work through Uplink too. A host too old to mint
 *  the URL still takes a video within the RPC limit. */
async function streamUpload(transport: WsTransport, name: string, body: Blob, ctx: IpcContext): Promise<string> {
  const sendByRpc = async () => transport.invoke('attachUpload', [ctx, { name, mime: body.type, dataUrl: await readFileDataUrl(body) }])
  let token: Awaited<ReturnType<SolusAPI['attachUploadToken']>>
  try {
    token = await transport.invoke('attachUploadToken', [ctx, { name, mime: body.type, size: body.size }])
  } catch (error) {
    if (body.size > MAX_ATTACHMENT_UPLOAD_BYTES) throw error
    return sendByRpc()
  }
  const response = await fetch(new URL(token.relativeUrl, `${transport.serverUrl.replace(/\/+$/, '')}/`), {
    method: 'POST',
    body,
  })
  if (!response.ok) throw new Error(`Upload failed (${response.status}).`)
  return token.hostPath
}
