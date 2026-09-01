import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createLogger } from '../logger'
import { appVersion, bundledResourcesDir, isPackagedRuntime, solusDir } from '../platform/paths'

const log = createLogger('Plugins', 'plugins.ts')

/** App-bundled source. Lives under resources/ — inside app.asar in production,
 *  but still readable by Node's asar-aware fs (the CLIs that consume them are
 *  separate processes that cannot, which is why we copy them out below).
 *  Resolved at call time: the app root is only known once Electron is ready. */
function bundledPluginsDir(): string {
  return join(bundledResourcesDir(), 'plugins')
}

/** Installed destination — co-located with the rest of Solus's config so the
 *  Claude Code and Codex CLIs can load plugins from a real filesystem path. */
export const PLUGINS_DIR = join(solusDir(), 'plugins')
export const SOLUS_PLUGINS_DIR = join(PLUGINS_DIR, 'solus')

/** Marks a packaged copy with the app version that produced it, so a warm
 *  launch can skip the recursive copy when nothing changed. */
const STAMP_NAME = '.solus-plugins-stamp'
const STAMP_FILE = join(PLUGINS_DIR, STAMP_NAME)

/** Packaged copies land here first and are renamed into place, so a partial
 *  copy never becomes the directory agents are pointed at. */
const STAGING_DIR = `${PLUGINS_DIR}.incoming`

/** Dev fast path: destination is already the symlink we'd re-create. */
async function symlinkAlreadyCurrent(source: string): Promise<boolean> {
  try {
    const stat = await lstat(PLUGINS_DIR)
    if (!stat.isSymbolicLink()) return false
    return (await readlink(PLUGINS_DIR)) === source
  } catch {
    return false
  }
}

/** Packaged fast path: a prior copy stamped with the current app version. */
async function copyAlreadyCurrent(): Promise<boolean> {
  try {
    return (await readFile(STAMP_FILE, 'utf8')).trim() === appVersion()
  } catch {
    return false
  }
}

/**
 * Copy one tree with the fs calls Electron makes asar-aware. `fs.cp` is not one
 * of them: it fails with ENOENT on every path inside app.asar, which silently
 * emptied the plugins dir in packaged builds. Only readdir, mkdir, and copyFile
 * are patched, so the walk stays explicit. Bundled plugins are plain files and
 * directories; anything else in the source is skipped rather than guessed at.
 */
async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) await copyFile(from, to)
  }
}

/**
 * Install the app-bundled plugins into the active Solus state dir. Runs once on
 * startup, before any agent is invoked.
 *
 * Every packaged runtime copies. The desktop app must, because external CLIs
 * cannot follow a symlink into app.asar; the standalone server copies for its
 * own reasons — Windows refuses `symlink()` without Developer Mode or admin,
 * and an install dir replaced by an upgrade would leave the link dangling. Dev
 * keeps the symlink so an edit under `resources/plugins` reaches the next agent
 * with no restart; a copy there would be pinned by a version stamp that never
 * changes between dev builds.
 *
 * Best-effort: a failure here just leaves agents running without the bundled
 * plugins rather than blocking startup.
 *
 * Warm launches short-circuit: dev when the symlink already points at the
 * source, packaged when the version stamp matches — so the copy only runs
 * when the destination is stale or the runtime kind (dev/packaged) changed.
 */
export async function syncBundledPlugins(): Promise<void> {
  const source = bundledPluginsDir()
  if (!existsSync(source)) {
    // Never silent: agents still receive PLUGINS_DIR, so a missing source means
    // every bundled skill disappears with no other symptom than the CLI
    // reporting an unknown plugin path.
    log.warn('bundled_plugins_source_missing', { source })
    return
  }
  // The runtime decides, not the shape of the source path: a target packaged
  // with `asar: false` still cannot be symlinked into on Windows.
  const packaged = isPackagedRuntime()
  try {
    if (packaged ? await copyAlreadyCurrent() : await symlinkAlreadyCurrent(source)) return
    await mkdir(dirname(PLUGINS_DIR), { recursive: true })
    if (packaged) {
      // Stage, stamp, then swap: the previous copy stays in place until a
      // complete one exists, so a failed sync degrades to a stale plugins dir
      // instead of no plugins at all.
      await rm(STAGING_DIR, { recursive: true, force: true })
      await copyTree(source, STAGING_DIR)
      await writeFile(join(STAGING_DIR, STAMP_NAME), appVersion(), { mode: 0o600 })
      await rm(PLUGINS_DIR, { recursive: true, force: true })
      await rename(STAGING_DIR, PLUGINS_DIR)
      return
    }
    await rm(PLUGINS_DIR, { recursive: true, force: true })
    await symlink(source, PLUGINS_DIR, 'dir')
  } catch (err) {
    log.warn('bundled_plugins_sync_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
