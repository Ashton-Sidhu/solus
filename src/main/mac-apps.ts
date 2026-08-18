import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Where macOS keeps applications. A per-user install under `~/Applications` is
 * as ordinary as a system-wide one, and probing only `/Applications` was why an
 * installed editor could look like it was not there at all.
 */
const APP_DIRECTORIES = [
  '/Applications',
  join(homedir(), 'Applications'),
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
]

/** The installed path of a bundle such as `Ghostty.app`, or null. */
export function findAppBundle(bundleName: string): string | null {
  if (process.platform !== 'darwin') return null
  for (const directory of APP_DIRECTORIES) {
    const path = join(directory, bundleName)
    if (existsSync(path)) return path
  }
  return null
}
