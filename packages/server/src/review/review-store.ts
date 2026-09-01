import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'

const log = createLogger('review', 'review-store.ts')

const REVIEW_DIR = '.solus'

/** Path to a review artifact: `.solus/<subdir>/<key>.json`. Every review store
 *  (ledger, guide, draft state) lives under one `<key>.json` per episode. */
export function artifactPath(repoRoot: string, subdir: string, key: string): string {
  return join(repoRoot, REVIEW_DIR, subdir, `${key}.json`)
}

/** Review guides are host cache data, not repository content. Key the storage
 *  directory by repository identity so equal branch names in different
 *  projects cannot collide, while keeping every guide outside the checkout it
 *  describes. `root` is injectable for tests. */
export function reviewGuidePath(
  repoRoot: string,
  key: string,
  root = join(dataDir(), 'review-guides'),
): string {
  const repositoryKey = createHash('sha256').update(repoRoot).digest('hex')
  return join(root, repositoryKey, `${key}.json`)
}

/** Read + parse a review artifact, or null if it doesn't exist yet (or the cache
 *  is corrupt). */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    // SAFETY: Each caller owns the artifact contract and either validates the result or requests its exact stored domain type.
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Overwrite a review artifact in place via tmp + rename, so a crashed write
 *  never leaves a half-written file on the branch. `label` only names the
 *  artifact in the error log. */
export async function writeJsonAtomic(path: string, data: Parameters<typeof JSON.stringify>[0], label: string): Promise<boolean> {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, path)
    return true
  } catch (err) {
    log.error('review_artifact_write_failed', { label, error: String(err) })
    return false
  }
}
