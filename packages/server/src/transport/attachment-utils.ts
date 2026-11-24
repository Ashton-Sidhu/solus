import { basename, join } from 'path'
import { readFileSync, statSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import type { Attachment } from '@solus/contracts/types'
import { heicJpegName, isHeicFile, mimeTypeFor } from '@solus/contracts/media-types'
import { heicToJpeg } from '../platform/heic-to-jpeg'

/** Images an agent reads as an image block. Any other image attaches as a file. */
const AGENT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

/**
 * Attachments for files on this host's disk. A HEIC photo is attached as a JPEG
 * copy when this host can make one, so every client can show it; the original
 * is never changed.
 */
export async function filePathsToAttachments(filePaths: string[]): Promise<Attachment[]> {
  return (await Promise.all(filePaths.map(showablePath))).map((fp: string) => {
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

async function showablePath(path: string): Promise<string> {
  if (!isHeicFile({ name: path })) return path
  const folder = await mkdtemp(join(tmpdir(), 'solus-heic-'))
  const jpegPath = join(folder, heicJpegName(basename(path)))
  if (await heicToJpeg(path, jpegPath)) return jpegPath
  await rm(folder, { recursive: true, force: true })
  return path
}
