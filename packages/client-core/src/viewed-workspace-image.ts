import { z } from 'zod'
import { hostPathSegments, isAbsoluteHostPath, relativeHostPath } from '@solus/contracts/host-path'
import { isRasterImage } from '@solus/contracts/media-types'

const imageReadTools = new Set(['Read', 'read_file', 'view_image'])
const fileInput = z.object({ file_path: z.string().optional(), path: z.string().optional() })

/** The literal file path named by a successful image read. */
export function viewedImagePath(
  toolName: string | undefined,
  toolInput: string | null | undefined,
  toolStatus: 'running' | 'completed' | 'error' | undefined,
): string | undefined {
  if (!toolName || !imageReadTools.has(toolName) || toolStatus !== 'completed' || !toolInput) return
  try {
    const input = fileInput.safeParse(JSON.parse(toolInput))
    if (!input.success) return
    const path = input.data.file_path ?? input.data.path
    if (!path || !isRasterImage(path) || /[\x00-\x1f]/.test(path)) return
    if (!isAbsoluteHostPath(path) && /^(?:[a-z][a-z\d+.-]*:|~[/\\]|\\)/i.test(path)) return
    return path
  } catch {
    return
  }
}

/** Only a file within this workspace can get an automatic preview. */
export function workspaceRelativeImagePath(path: string, workspaceRoot: string | null | undefined): string | null {
  if (!workspaceRoot || !isAbsoluteHostPath(workspaceRoot)) return null
  const relative = isAbsoluteHostPath(path) ? relativeHostPath(workspaceRoot, path) : path
  if (!relative) return null
  const segments = hostPathSegments(relative)
  if (segments.includes('..')) return null
  return segments.filter((segment) => segment !== '.').join('/') || null
}
