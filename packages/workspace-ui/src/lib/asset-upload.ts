import type { HostApi } from '@solus/client-core/host-api'
import { z } from 'zod'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  type AssetUploadResult,
} from '@solus/contracts/rpc'

const imageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function attachmentFilesFromDataTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files: File[] = []
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length === 0) {
    files.push(...Array.from(transfer.files ?? []))
  }
  return files
}

export function isInlineAssetImage(file: Pick<File, 'type'>): boolean {
  return imageMimeSchema.safeParse(file.type).success
}

function readDataUrl(file: File): Promise<string> {
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    return Promise.reject(new Error('Attachments can be up to 10 MB.'))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const parsed = z.string().safeParse(reader.result)
      if (parsed.success) resolve(parsed.data)
      else reject(new Error('Unable to read the attachment.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the attachment.'))
    reader.readAsDataURL(file)
  })
}

export async function uploadAsset(api: Pick<HostApi, 'assetUpload'>, file: File): Promise<AssetUploadResult> {
  const mime = file.type || 'application/octet-stream'
  return api.assetUpload({
    name: file.name || 'pasted image',
    mime,
    dataUrl: await readDataUrl(file),
  })
}

function markdownLabel(name: string): string {
  return (name || 'attachment').replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
}

export function assetImageMarkdown(name: string, uri: string): string {
  return `![${markdownLabel(name || 'pasted image')}](${uri})`
}

export function assetFileMarkdown(name: string, uri: string): string {
  return `[${markdownLabel(name)}](${uri})`
}
