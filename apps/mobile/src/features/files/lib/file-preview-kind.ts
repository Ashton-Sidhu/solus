import { mediaTypeFor } from '@solus/contracts/media-types'

/**
 * How the phone's file screen shows a file beyond plain source. Media types
 * are the host's own list (`mediaTypeFor`), so the phone never offers a
 * preview the host will not sign a URL for. Audio is T3 Code's list: a host
 * that signs it plays; one that refuses shows the binary notice.
 */

const MARKDOWN_FILE_PATTERN = /\.(?:md|markdown|mdx)$/i
const AUDIO_FILE_PATTERN = /\.(?:mp3|wav|ogg|oga|flac|aac|m4a|opus|aiff)$/i

export type FileMediaView = 'image' | 'video' | 'audio' | 'document'

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_PATTERN.test(path)
}

/** The media surface for a path, or null when the file is text or an unknown binary. */
export function fileMediaView(path: string): FileMediaView | null {
  if (AUDIO_FILE_PATTERN.test(path)) return 'audio'
  const media = mediaTypeFor(path)
  if (!media) return null
  // React Native draws raster images only; SVG and PDF open in the browser.
  if (media.kind === 'image') return media.mime === 'image/svg+xml' ? 'document' : 'image'
  return media.kind === 'video' ? 'video' : 'document'
}

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)
}

/** `target` relative to the folder of `filePath`, with `.` and `..` segments applied. */
export function resolveMarkdownRelativePath(filePath: string, target: string): string {
  if (isAbsoluteHostPath(target)) return target
  const segments = filePath.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}
