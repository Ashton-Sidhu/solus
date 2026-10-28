/**
 * A rename that survives a short lock on Windows. A scanner, an indexer, or
 * antivirus can hold a new file or folder open for a short time, and the
 * rename then fails with EBUSY, EPERM, or EACCES (`docs/plans/windows.md` §5.5).
 * The CLI has the same rule in `apps/cli/src/lib/rename-retry.ts`. On other
 * platforms this is one rename.
 */
import { rename as renamePath } from 'node:fs/promises'

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const ATTEMPTS = 20
const RETRY_DELAY_MS = 100

export async function renameRetrying(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  rename: (from: string, to: string) => Promise<void> = renamePath,
  delayMs = RETRY_DELAY_MS,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (platform !== 'win32' || attempt >= ATTEMPTS || !RETRY_CODES.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
