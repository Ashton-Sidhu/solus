import { hostPathBaseName } from './host-path'

/** Largest video one upload or recording may be. Images keep the 10 MB attachment limit. */
export const MAX_VIDEO_UPLOAD_BYTES = 50 * 1024 * 1024

/** What a client can show a file as, instead of text. */
export type MediaKind = 'image' | 'pdf' | 'video'

export interface MediaType {
  kind: MediaKind
  mime: string
}

/**
 * The one list of file types Solus shows as media, keyed by lowercased
 * extension. Every entry must display natively in the browsers Solus supports:
 * a type that needs conversion (HEIC) does not belong here.
 */
const MEDIA_TYPE_BY_EXTENSION = new Map<string, MediaType>([
  ['png', { kind: 'image', mime: 'image/png' }],
  ['jpg', { kind: 'image', mime: 'image/jpeg' }],
  ['jpeg', { kind: 'image', mime: 'image/jpeg' }],
  ['gif', { kind: 'image', mime: 'image/gif' }],
  ['webp', { kind: 'image', mime: 'image/webp' }],
  ['avif', { kind: 'image', mime: 'image/avif' }],
  ['bmp', { kind: 'image', mime: 'image/bmp' }],
  ['ico', { kind: 'image', mime: 'image/x-icon' }],
  ['svg', { kind: 'image', mime: 'image/svg+xml' }],
  ['pdf', { kind: 'pdf', mime: 'application/pdf' }],
  ['mp4', { kind: 'video', mime: 'video/mp4' }],
  ['m4v', { kind: 'video', mime: 'video/mp4' }],
  ['mov', { kind: 'video', mime: 'video/quicktime' }],
  ['webm', { kind: 'video', mime: 'video/webm' }],
])

/** Text types worth naming; any other text file has no MIME type. */
const TEXT_MIME_BY_EXTENSION = new Map([
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['json', 'application/json'],
  ['yaml', 'text/yaml'],
  ['toml', 'text/toml'],
])

function extensionOf(path: string): string {
  const leaf = hostPathBaseName(path)
  const dot = leaf.lastIndexOf('.')
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : ''
}

export const VIDEO_FILE_EXTENSIONS: readonly string[] = Object.freeze(
  [...MEDIA_TYPE_BY_EXTENSION].filter(([, type]) => type.kind === 'video').map(([extension]) => extension),
)

export const IMAGE_FILE_EXTENSIONS: readonly string[] = Object.freeze(
  [...MEDIA_TYPE_BY_EXTENSION].filter(([, type]) => type.kind === 'image').map(([extension]) => extension),
)

/** The media type a path names by its extension, or null for any other file. */
export function mediaTypeFor(path: string): MediaType | null {
  return MEDIA_TYPE_BY_EXTENSION.get(extensionOf(path)) ?? null
}

/** The MIME type a path names by its extension: a media type or a known text type. */
export function mimeTypeFor(path: string): string | undefined {
  const extension = extensionOf(path)
  return MEDIA_TYPE_BY_EXTENSION.get(extension)?.mime ?? TEXT_MIME_BY_EXTENSION.get(extension)
}

/** An image drawn from pixels. SVG is markup: it can carry script, so it never
 *  renders as a plain image from bytes nobody checked. */
export function isRasterImage(path: string): boolean {
  const type = mediaTypeFor(path)
  return type?.kind === 'image' && type.mime !== 'image/svg+xml'
}

/** What a picker reports when it does not know the type. Only then does the
 *  file name count as evidence. */
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

/** Video types an operating system gives a `.ts` file by its extension alone:
 *  macOS reports `video/mp2t` and Windows `video/vnd.dlna.mpeg-tts`. A TypeScript
 *  file gets them too, so they say nothing and the name decides. */
const EXTENSION_GUESSED_VIDEO_TYPES = new Set(['video/mp2t', 'video/vnd.dlna.mpeg-tts'])

/**
 * The video MIME type of a file, or null when it is not a video.
 *
 * A definite MIME type answers the question: a `.mp4` name on a PDF stays a PDF.
 * The extension is read only when the picker reported no type or a generic one,
 * which is what some pickers and drag sources do for video, or a type the
 * operating system guessed from a `.ts` extension.
 */
export function videoMimeType(file: { name: string; mimeType?: string | null }): string | null {
  const mimeType = (file.mimeType ?? '').split(';', 1)[0].trim().toLowerCase()
  if (mimeType.startsWith('video/') && !EXTENSION_GUESSED_VIDEO_TYPES.has(mimeType)) return mimeType
  if (!GENERIC_MIME_TYPES.has(mimeType) && !EXTENSION_GUESSED_VIDEO_TYPES.has(mimeType)) return null
  const type = mediaTypeFor(file.name)
  return type?.kind === 'video' ? type.mime : null
}

/** The type Solus records for a DNG. It is not registered with IANA, but it is
 *  the usual name, and no client reads it as a picture it can show. */
export const DNG_MIME_TYPE = 'image/x-adobe-dng'

const DNG_MIME_TYPES = new Set(['image/dng', 'image/x-dng', DNG_MIME_TYPE])

/**
 * Whether a file is a DNG camera original. Browsers label one as PNG, JPEG,
 * TIFF, or nothing, so the extension decides before the reported type.
 */
export function isDngFile(file: { name: string; mimeType?: string | null }): boolean {
  if (file.name.toLowerCase().endsWith('.dng')) return true
  return DNG_MIME_TYPES.has((file.mimeType ?? '').split(';', 1)[0].trim().toLowerCase())
}

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])

/**
 * Whether a file is a HEIC or HEIF photo, the format an iPhone takes. No browser
 * that Solus supports can show one, so a host turns it into a JPEG when it can
 * (`heicToJpeg`) and keeps it as a file when it cannot.
 */
export function isHeicFile(file: { name: string; mimeType?: string | null }): boolean {
  if (/\.(heic|heif)$/i.test(file.name)) return true
  return HEIC_MIME_TYPES.has((file.mimeType ?? '').split(';', 1)[0].trim().toLowerCase())
}

/** The name of the JPEG a host makes from a HEIC photo: `IMG_1.heic` becomes `IMG_1.jpg`. */
export function heicJpegName(name: string): string {
  return /\.(heic|heif)$/i.test(name) ? name.replace(/\.(heic|heif)$/i, '.jpg') : `${name}.jpg`
}

/** What a picked file is, read the same way on every client. A video is a
 *  `file` attachment with its video MIME type, never an image. A DNG is a
 *  `file` too: an agent cannot read it as an image, so its original bytes go
 *  to the host as they are. A HEIC photo is a `file` until its host turns it
 *  into a JPEG (`landedAttachmentKind`). */
export interface AttachmentKind {
  type: 'image' | 'file'
  mimeType: string
  isVideo: boolean
}

export function attachmentKind(file: { name: string; mimeType?: string | null }): AttachmentKind {
  const video = videoMimeType(file)
  if (video) return { type: 'file', mimeType: video, isVideo: true }
  if (isDngFile(file)) return { type: 'file', mimeType: DNG_MIME_TYPE, isVideo: false }
  if (isHeicFile(file)) {
    const mimeType = file.mimeType && HEIC_MIME_TYPES.has(file.mimeType) ? file.mimeType : 'image/heic'
    return { type: 'file', mimeType, isVideo: false }
  }
  const mimeType = file.mimeType || 'application/octet-stream'
  return { type: mimeType.startsWith('image/') ? 'image' : 'file', mimeType, isVideo: false }
}

/**
 * What an uploaded file is once its host holds it. A host that can turns a HEIC
 * photo into a JPEG and answers with the JPEG's path; the attachment is then that
 * image. Any other file, or a host that kept the HEIC, keeps its kind.
 */
export function landedAttachmentKind(kind: AttachmentKind, name: string, hostPath: string): AttachmentKind {
  if (!isHeicFile({ name, mimeType: kind.mimeType })) return kind
  if (mediaTypeFor(hostPath)?.mime !== 'image/jpeg') return kind
  return { type: 'image', mimeType: 'image/jpeg', isVideo: false }
}
