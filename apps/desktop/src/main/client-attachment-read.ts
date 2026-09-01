import { realpathSync } from 'fs'

const READ_ALLOWLIST_TTL_MS = 5 * 60 * 1000
const allowedPaths = new Map<string, number>()

/** Allow one byte read for each path the user selected in the native dialog. */
export function allowClientAttachmentReads(paths: string[], now = Date.now()): void {
  const expiresAt = now + READ_ALLOWLIST_TTL_MS
  for (const path of paths) {
    try {
      allowedPaths.set(realpathSync(path), expiresAt)
    } catch {}
  }
}

export function consumeClientAttachmentRead(path: string, now = Date.now()): string | null {
  let canonicalPath: string
  try {
    canonicalPath = realpathSync(path)
  } catch {
    return null
  }
  const expiresAt = allowedPaths.get(canonicalPath)
  allowedPaths.delete(canonicalPath)
  return expiresAt && expiresAt >= now ? canonicalPath : null
}
