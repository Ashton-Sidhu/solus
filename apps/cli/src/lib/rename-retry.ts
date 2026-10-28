/**
 * A rename that survives a short lock on Windows. A scanner, an indexer, or
 * antivirus can hold a new file or folder open for a short time, and the
 * rename then fails with EBUSY, EPERM, or EACCES (`docs/plans/windows.md` §5.5).
 * The server has the same rule in `packages/server/src/platform/rename-retry.ts`;
 * the CLI cannot import `@solus/server`, so this is its own small copy.
 * On other platforms this is one rename.
 */
import { renameSync } from 'node:fs'

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const ATTEMPTS = 20
const RETRY_DELAY_MS = 100

export function renameRetrying(from: string, to: string, platform: NodeJS.Platform = process.platform, rename: (from: string, to: string) => void = renameSync): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (platform !== 'win32' || attempt >= ATTEMPTS || !RETRY_CODES.has(code)) throw error
      // The callers are synchronous; a blocking wait keeps them so.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS)
    }
  }
}
