import { hostPathSegments, hostPathSeparator, isAbsoluteHostPath } from '@solus/contracts/host-path'
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
  // React Native `Image` draws raster images only; SVG and PDF open in the platform viewer.
  if (media.kind === 'image') return media.mime === 'image/svg+xml' ? 'document' : 'image'
  return media.kind === 'video' ? 'video' : 'document'
}

/** `target` relative to the folder of `filePath`, with `.` and `..` segments
 *  applied, in `filePath`'s own separator. */
export function resolveMarkdownRelativePath(filePath: string, target: string): string {
  if (isAbsoluteHostPath(target) || target.startsWith('~')) return target
  const segments = hostPathSegments(filePath).slice(0, -1)
  for (const segment of hostPathSegments(target)) {
    if (segment === '.') continue
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') segments.pop()
    else segments.push(segment)
  }
  // The segments drop a POSIX or UNC root; a drive root is the first segment.
  // oxlint-disable-next-line solus/host-path-separators
  const root = filePath.startsWith('/') ? '/' : filePath.startsWith('\\\\') ? '\\\\' : ''
  return root + segments.join(hostPathSeparator(filePath))
}
