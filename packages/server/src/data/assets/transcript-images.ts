import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod'
import type { PromptImageRef, ToolResultImage } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { pngPixelSize, type ImageSize } from '../../docs/png'
import { rasterImageMimeOf } from './assets'
import { storedAssetPath } from './asset-paths'

/**
 * Images in a transcript, moved out of it.
 *
 * A tool can return a picture (an MCP image block, a Read of a PNG, a device
 * screenshot), and a prompt can carry one. In provider output they are base64.
 * The host writes each one to its asset store under its content hash and puts a
 * small reference where the bytes were, so no client receives image bytes in a
 * session event or a history page; it loads the picture through a signed asset
 * URL when the picture is on screen, over IPC or a web socket alike.
 *
 * The write is synchronous because the provider normalizers and history
 * parsers that find these images are. The asset id is the SHA-256 of the
 * bytes, so a history reload finds the file it wrote the first time and
 * writes nothing; it pays one decode and one hash per image, the same order of
 * work as the JSON parse of the line that carried it.
 */

/** A tool call shows at most this many images. */
export const MAX_TOOL_RESULT_IMAGES = 8
/** Larger images are not stored: no provider accepts them in a turn either. */
export const MAX_TRANSCRIPT_IMAGE_BYTES = 10 * 1024 * 1024

/** Only raster types a browser shows safely; never SVG or HTML. */
const EXTENSION_BY_MIME = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

interface InlineImage {
  mimeType: string
  base64: string
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]*)$/i

/** The shapes providers write an image block in. */
const imagePartSchema = z.union([
  // Claude: tool_result content and prompt blocks.
  z.object({
    type: z.literal('image'),
    source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
  }),
  // MCP: a tool's own result, as Codex records it.
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  // Codex dynamic tools: a data URL.
  z.object({ type: z.literal('inputImage'), imageUrl: z.string() }),
])

function inlineImageOf<Part>(part: Part): InlineImage | null {
  const parsed = imagePartSchema.safeParse(part)
  if (!parsed.success) return null
  const image = parsed.data
  if ('source' in image) return { mimeType: image.source.media_type, base64: image.source.data }
  if ('data' in image) return { mimeType: image.mimeType, base64: image.data }
  return inlineImageOfDataUrl(image.imageUrl)
}

function inlineImageOfDataUrl(dataUrl: string): InlineImage | null {
  const match = DATA_URL.exec(dataUrl)
  return match ? { mimeType: match[1], base64: match[2] } : null
}

/** Width and height from the image header, or null when it cannot be read. */
function pixelSize(bytes: Buffer, mimeType: string): ImageSize | null {
  try {
    if (mimeType === 'image/png') return pngPixelSize(bytes)
    if (mimeType === 'image/gif') return sized(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    if (mimeType === 'image/webp') return webpPixelSize(bytes)
    if (mimeType === 'image/jpeg') return jpegPixelSize(bytes)
  } catch {}
  return null
}

function sized(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null
}

function webpPixelSize(bytes: Buffer): ImageSize | null {
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X') return sized(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
  if (chunk === 'VP8 ') return sized(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  return null
}

/** The first start-of-frame segment names the size. */
function jpegPixelSize(bytes: Buffer): ImageSize | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset++
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return sized(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5))
    }
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  return null
}

/**
 * Store one image and return its reference, or null when it is not an
 * allowed raster type, is too large, or its bytes do not match its type.
 */
function storeInlineImage(image: InlineImage, assetsDir?: string): ToolResultImage | null {
  if (image.base64.length > Math.ceil(MAX_TRANSCRIPT_IMAGE_BYTES / 3) * 4) return null
  const bytes = Buffer.from(image.base64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_TRANSCRIPT_IMAGE_BYTES) return null
  // The bytes name the type. A provider label can be wrong, and an unknown
  // type must never be served inline.
  const mimeType = rasterImageMimeOf(bytes)
  const extension = mimeType ? EXTENSION_BY_MIME.get(mimeType) : undefined
  if (!mimeType || !extension) return null
  const assetId = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`
  const target = storedAssetPath(assetId, assetsDir)
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${assetId}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      try {
        renameSync(temporary, target)
      } catch (error) {
        // Another writer stored the same bytes first; the content is identical.
        if (!existsSync(target)) throw error
      }
    } finally {
      try { unlinkSync(temporary) } catch {}
    }
  }
  const ref: ToolResultImage = { assetId, mimeType }
  const size = pixelSize(bytes, mimeType)
  if (size) {
    ref.width = size.width
    ref.height = size.height
  }
  return ref
}

/**
 * Store the images in one tool result's content blocks and return their
 * references, or undefined when it has none. A block that is not an image is
 * skipped; so is a write that fails, because a missing picture must not cost
 * the tool row.
 */
export function storeToolResultImages<Parts>(parts: Parts, assetsDir?: string): ToolResultImage[] | undefined {
  if (!Array.isArray(parts)) return undefined
  const images: ToolResultImage[] = []
  for (const part of parts) {
    if (images.length >= MAX_TOOL_RESULT_IMAGES) break
    const inline = inlineImageOf(part)
    if (!inline) continue
    try {
      const stored = storeInlineImage(inline, assetsDir)
      if (stored) images.push(stored)
    } catch {}
  }
  return images.length ? images : undefined
}

/** A copy of content blocks with each image's bytes removed and its type kept,
 *  so a tool's text output can be kept without the base64 it carried. */
export function withoutImageBytes<Parts>(parts: Parts): Parts | Array<{ type: 'image'; mimeType: string }> {
  if (!Array.isArray(parts)) return parts
  return parts.map((part) => {
    const inline = inlineImageOf(part)
    return inline ? { type: 'image' as const, mimeType: inline.mimeType } : part
  })
}

/**
 * Move a history page's prompt images from inline data URLs to the asset
 * store, so a reload sends each picture once as a file instead of as base64 in
 * every page. An image the store will not take (an unknown type, too large)
 * stays inline. Mutates the user rows in place; they are fresh from the reader.
 */
export function storePromptImages<Message extends Pick<SessionLoadMessage, 'role' | 'imageAttachments' | 'imageAttachmentRefs'>>(
  messages: Message[],
  assetsDir?: string,
): Message[] {
  for (const message of messages) {
    if (message.role !== 'user' || !message.imageAttachments?.length) continue
    const inline: NonNullable<SessionLoadMessage['imageAttachments']> = []
    const refs: PromptImageRef[] = [...message.imageAttachmentRefs ?? []]
    for (const attachment of message.imageAttachments) {
      const image = inlineImageOfDataUrl(attachment.dataUrl)
      let stored: ToolResultImage | null = null
      try {
        stored = image ? storeInlineImage(image, assetsDir) : null
      } catch {}
      if (stored) refs.push({ mimeType: stored.mimeType, hostPath: storedAssetPath(stored.assetId, assetsDir) })
      else inline.push(attachment)
    }
    message.imageAttachments = inline.length ? inline : undefined
    message.imageAttachmentRefs = refs.length ? refs : undefined
  }
  return messages
}
