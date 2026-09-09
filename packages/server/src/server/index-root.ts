import { realpath } from 'fs/promises'
import { homedir } from 'os'
import { dirname } from 'path'
import { isInsideRoot } from '../paths'

/** Canonicalize before checking so symlinks and dot segments cannot bypass
 * the limit. Home and its ancestors are never project index roots. */
export async function resolveIndexRoot(basePath: string): Promise<string | null> {
  try {
    const [root, home] = await Promise.all([realpath(basePath), realpath(homedir())])
    return dirname(root) === root || isInsideRoot(root, home) ? null : root
  } catch {
    return null
  }
}
