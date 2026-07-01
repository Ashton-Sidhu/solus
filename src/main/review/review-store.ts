import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('review', 'review-store.ts')

const REVIEW_DIR = '.solus'

/** Path to a review artifact: `.solus/<subdir>/<key>.json`. Every review store
 *  (ledger, guide, draft state) lives under one `<key>.json` per episode. */
export function artifactPath(repoRoot: string, subdir: string, key: string): string {
  return join(repoRoot, REVIEW_DIR, subdir, `${key}.json`)
}

/** Read + parse a review artifact, or null if it doesn't exist yet (or the cache
 *  is corrupt). */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Overwrite a review artifact in place via tmp + rename, so a crashed write
 *  never leaves a half-written file on the branch. `label` only names the
 *  artifact in the error log. */
export async function writeJsonAtomic(path: string, data: unknown, label: string): Promise<boolean> {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, path)
    return true
  } catch (err) {
    log.error(`write ${label} failed: ${String(err)}`)
    return false
  }
}
