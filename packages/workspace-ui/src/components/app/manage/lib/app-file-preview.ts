import type { AppFileView } from '@solus/contracts/apps'

/**
 * Which app files the Files section previews (docs/plans/apps.md §9.2): an
 * image as it is, and a PDF as its first page. The preview reads the file
 * through the same `@files/read` call as Download, so a file larger than the
 * bound shows the file glyph instead of a read of many megabytes.
 */

/** The largest file the inspector reads for its preview. */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024

/** The image types a browser draws in an `<img>` with no risk: an SVG there runs no script. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml'])

export type FilePreviewKind = 'image' | 'pdf'

/** How the file previews, or null when it shows the file glyph. */
export function filePreviewKind(file: Pick<AppFileView, 'name' | 'type' | 'size'>): FilePreviewKind | null {
  if (file.size === 0 || file.size > PREVIEW_MAX_BYTES) return null
  const type = file.type.split(';')[0]!.trim().toLowerCase()
  if (IMAGE_TYPES.has(type)) return 'image'
  if (type === 'application/pdf' || (type === 'application/octet-stream' && file.name.toLowerCase().endsWith('.pdf'))) return 'pdf'
  return null
}
