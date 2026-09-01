import { basename, extname } from 'path'
import { readFileSync, statSync } from 'fs'
import type { Attachment } from '../../shared/types'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
}

export function mimeTypeForExtension(ext: string): string | undefined {
  return MIME_MAP[ext.toLowerCase()]
}

export function filePathsToAttachments(filePaths: string[]): Attachment[] {
  return filePaths.map((fp: string) => {
    const ext = extname(fp).toLowerCase()
    const mime = mimeTypeForExtension(ext) || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    if (IMAGE_EXTS.has(ext) && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  })
}
