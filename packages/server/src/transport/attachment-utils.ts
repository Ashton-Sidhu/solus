import { basename } from 'path'
import { readFileSync, statSync } from 'fs'
import type { Attachment } from '@solus/contracts/types'
import { mimeTypeFor } from '@solus/contracts/media-types'

/** Images an agent reads as an image block. Any other image attaches as a file. */
const AGENT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

export function filePathsToAttachments(filePaths: string[]): Attachment[] {
  return filePaths.map((fp: string) => {
    const mime = mimeTypeFor(fp) || 'application/octet-stream'
    const isImage = AGENT_IMAGE_MIME_TYPES.has(mime)
    const stat = statSync(fp)
    let dataUrl: string | undefined

    if (isImage && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: isImage ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  })
}
