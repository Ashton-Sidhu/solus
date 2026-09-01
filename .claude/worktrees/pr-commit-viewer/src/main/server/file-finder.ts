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
    log.warn('file_finder_load_failed', { basePath, error: err instanceof Error ? err.message : String(err) })
    return null
  }
  if (!created.ok) {
    log.warn('file_finder_create_failed', { basePath, error: String(created.error) })
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

// Content indexing costs scan CPU and memory that the path-only consumers
// (autocomplete, file tree, quick open) must not pay for, so project content
// search gets its own finder per root. These are kept out of the path LRU
// above: a session with several worktrees would otherwise let its content
// indices evict each other's path indices. They expire on idle instead, since
// a search burst is followed by long silence.
const CONTENT_FINDER_IDLE_MS = 15 * 60_000

interface ContentFinderEntry extends FinderEntry {
  idleTimer: ReturnType<typeof setTimeout> | null
}

const contentFinders = new Map<string, ContentFinderEntry>()

function touchContentFinder(basePath: string, entry: ContentFinderEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => {
    contentFinders.delete(basePath)
    try { entry.finder.destroy() } catch { /* already destroyed */ }
    log.info('content_finder_idle_destroyed', { basePath })
  }, CONTENT_FINDER_IDLE_MS)
  entry.idleTimer.unref?.()
}

/** The content-indexed finder for a root, created on first search. */
export async function getContentFinder(basePath: string): Promise<FileFinder | null> {
  const hit = contentFinders.get(basePath)
  if (hit) {
    touchContentFinder(basePath, hit)
    await hit.scanned
    return hit.finder
  }

  let created: ReturnType<typeof FileFinder.create>
  try {
    const { FileFinder } = await loadFff()
    created = FileFinder.create({
      basePath,
      disableMmapCache: true,
      disableContentIndexing: false,
      aiMode: false,
      enableFsRootScanning: true,
      enableHomeDirScanning: true,
    })
  } catch (err) {
    log.warn('content_finder_load_failed', { basePath, error: err instanceof Error ? err.message : String(err) })
    return null
  }
  if (!created.ok) {
    log.warn('content_finder_create_failed', { basePath, error: String(created.error) })
    return null
  }

  const entry: ContentFinderEntry = {
    finder: created.value,
    scanned: created.value.waitForScan(SCAN_TIMEOUT_MS).catch(() => {}),
    idleTimer: null,
  }
  contentFinders.set(basePath, entry)
  touchContentFinder(basePath, entry)
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
    log.warn('file_finder_scan_failed', { basePath, error: String(result.error) })
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
  for (const entry of contentFinders.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    try { entry.finder.destroy() } catch { /* already destroyed */ }
  }
  contentFinders.clear()
}
