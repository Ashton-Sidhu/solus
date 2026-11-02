import type { Attachment } from '@solus/contracts/types'
import { hostPathBaseName, UPLOAD_NAME_PREFIX } from '@solus/contracts/host-path'
import { resolveHostMediaUrl, type HostMediaRequest } from '../../../lib/host-media-url.svelte'
import { downloadBlob } from '../../work/lib/work-export'

/**
 * The name a downloaded attachment is saved under: the name it was sent with,
 * else the host file's own name without the upload prefix. Never a label —
 * "Pasted text" is what the card says, not what the file is called.
 */
export function attachmentDownloadName(attachment: Pick<Attachment, 'name' | 'path' | 'hostPath'>): string {
  if (attachment.name.trim()) return attachment.name
  const leaf = hostPathBaseName(attachment.hostPath ?? attachment.path).replace(UPLOAD_NAME_PREFIX, '')
  return leaf || 'attachment'
}

/**
 * Pull a host file onto the device running the client. The bytes come through
 * the host's signed asset URL — the same one an image or video loads from — so
 * a client on another machine than the host downloads exactly as a local one.
 */
export async function downloadHostFile(request: HostMediaRequest, fileName: string): Promise<void> {
  const url = await resolveHostMediaUrl(request)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Couldn't download ${fileName}: the host answered ${response.status}.`)
  downloadBlob(fileName, await response.blob())
}
