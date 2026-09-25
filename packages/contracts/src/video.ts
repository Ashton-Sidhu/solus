/** Largest video one upload or recording may be. Images keep the 10 MB attachment limit. */
export const MAX_VIDEO_UPLOAD_BYTES = 50 * 1024 * 1024

const VIDEO_MIME_TYPE_BY_EXTENSION = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
])

export const VIDEO_FILE_EXTENSIONS: readonly string[] = Object.freeze([...VIDEO_MIME_TYPE_BY_EXTENSION.keys()])

/** What a picker reports when it does not know the type. Only then does the
 *  file name count as evidence. */
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

/**
 * The video MIME type of a file, or null when it is not a video.
 *
 * A definite MIME type answers the question: a `.mp4` name on a PDF stays a PDF.
 * The extension is read only when the picker reported no type or a generic one,
 * which is what some pickers and drag sources do for video.
 */
export function videoMimeType(file: { name: string; mimeType?: string | null }): string | null {
  const mimeType = (file.mimeType ?? '').split(';', 1)[0].trim().toLowerCase()
  if (mimeType.startsWith('video/')) return mimeType
  if (!GENERIC_MIME_TYPES.has(mimeType)) return null
  const dot = file.name.lastIndexOf('.')
  if (dot < 0) return null
  return VIDEO_MIME_TYPE_BY_EXTENSION.get(file.name.slice(dot + 1).toLowerCase()) ?? null
}
