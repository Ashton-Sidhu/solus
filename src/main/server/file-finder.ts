import type { FileFinder } from '@ff-labs/fff-node'
import { createLogger } from '../logger'

// @ff-labs/fff-node is ESM-only while the main bundle is CJS, so it must be
// loaded with a dynamic import (kept native by rollup) instead of require.
let fffModule: Promise<typeof import('@ff-labs/fff-node')> | null = null
function loadFff() {
  return (fffModule ??= import('@ff-labs/fff-node'))
}

const log = createLogger('main', 'file-finder')

// One fff index per base directory. The common case is a single finder per
// open project; path queries outside the project (e.g. ~/Downloads/…) get
// their own finder bound to the deepest existing directory of the query.
const MAX_FINDERS = 8
const SCAN_TIMEOUT_MS = 5_000

interface FinderEntry {
  finder: FileFinder
  scanned: Promise<unknown>
}

const finders = new Map<string, FinderEntry>()

export async function getFinder(basePath: string): Promise<FileFinder | null> {
  const hit = finders.get(basePath)
  if (hit) {
    // Refresh LRU position.
    finders.delete(basePath)
    finders.set(basePath, hit)
    await hit.scanned
    return hit.finder
  }

  let created: ReturnType<typeof FileFinder.create>
  try {
    const { FileFinder } = await loadFff()
    created = FileFinder.create({
      basePath,
      disableMmapCache: true,
      disableContentIndexing: true,
      aiMode: false,
      enableFsRootScanning: true,
      enableHomeDirScanning: true,
    })
  } catch (err) {
    log.warn(`FileFinder failed to load for ${basePath}: ${err}`)
    return null
  }
  if (!created.ok) {
    log.warn(`FileFinder.create failed for ${basePath}: ${created.error}`)
    return null
  }

  if (finders.size >= MAX_FINDERS) {
    const oldest = finders.keys().next().value!
    finders.get(oldest)!.finder.destroy()
    finders.delete(oldest)
  }

  const entry: FinderEntry = {
    finder: created.value,
    scanned: created.value.waitForScan(SCAN_TIMEOUT_MS).catch(() => {}),
  }
  finders.set(basePath, entry)
  await entry.scanned
  return entry.finder
}

/** Best-effort prewarm so the first autocomplete keystroke hits a ready index. */
export function warmFinder(basePath: string): void {
  void getFinder(basePath).catch(() => {})
}

export async function refreshFinder(basePath: string): Promise<void> {
  const entry = finders.get(basePath)
  if (!entry) return

  const result = entry.finder.scanFiles()
  if (!result.ok) {
    log.warn(`FileFinder.scanFiles failed for ${basePath}: ${result.error}`)
    try { entry.finder.destroy() } catch { /* already destroyed */ }
    finders.delete(basePath)
    return
  }

  entry.scanned = entry.finder.waitForScan(SCAN_TIMEOUT_MS).catch(() => {})
  await entry.scanned
}

export function destroyAllFinders(): void {
  for (const { finder } of finders.values()) {
    try { finder.destroy() } catch { /* already destroyed */ }
  }
  finders.clear()
}
