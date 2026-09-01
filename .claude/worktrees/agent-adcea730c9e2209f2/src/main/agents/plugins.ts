import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '../logger'
import { appVersion } from '../platform/paths'

const log = createLogger('Plugins', 'plugins.ts')

/** App-bundled source. Lives under resources/ — inside app.asar in production,
 *  but still readable by Node's asar-aware fs (the CLIs that consume them are
 *  separate processes that cannot, which is why we copy them out below). */
const BUNDLED_PLUGINS_DIR = join(__dirname, '../../resources/plugins')

/** Installed destination — co-located with the rest of Solus's config so the
 *  Claude Code and Codex CLIs can load plugins from a real filesystem path. */
export const PLUGINS_DIR = join(homedir(), '.solus', 'plugins')
export const SOLUS_PLUGINS_DIR = join(PLUGINS_DIR, 'solus')

/** Marks a packaged copy with the app version that produced it, so a warm
 *  launch can skip the rm+recursive-copy when nothing changed. */
const STAMP_FILE = join(PLUGINS_DIR, '.solus-plugins-stamp')

/** Dev fast path: destination is already the symlink we'd re-create. */
async function symlinkAlreadyCurrent(): Promise<boolean> {
  try {
    const stat = await lstat(PLUGINS_DIR)
    if (!stat.isSymbolicLink()) return false
    return (await readlink(PLUGINS_DIR)) === BUNDLED_PLUGINS_DIR
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
 * Link the app-bundled plugins into ~/.solus/plugins. Runs once on startup,
 * before any agent is invoked. In dev this keeps agents pointed at the working
 * tree so plugin changes are immediately testable. Packaged builds still copy
 * from app.asar because external CLIs cannot follow a symlink into asar.
 * Best-effort: a failure here just leaves agents running without the bundled
 * plugins rather than blocking startup.
 *
 * Warm launches short-circuit: dev when the symlink already points at the
 * source, packaged when the version stamp matches — so the rm+copy only runs
 * when the destination is stale or the runtime kind (dev/packaged) changed.
 */
export async function syncBundledPlugins(): Promise<void> {
  if (!existsSync(BUNDLED_PLUGINS_DIR)) return
  const packaged = BUNDLED_PLUGINS_DIR.includes('.asar')
  try {
    if (packaged ? await copyAlreadyCurrent() : await symlinkAlreadyCurrent()) return
    await rm(PLUGINS_DIR, { recursive: true, force: true })
    await mkdir(dirname(PLUGINS_DIR), { recursive: true })
    if (packaged) {
      await cp(BUNDLED_PLUGINS_DIR, PLUGINS_DIR, { recursive: true })
      await writeFile(STAMP_FILE, appVersion(), { mode: 0o600 })
      return
    }
    await symlink(BUNDLED_PLUGINS_DIR, PLUGINS_DIR, 'dir')
  } catch (err) {
    log.warn(`Failed to sync bundled plugins: ${(err as Error).message}`)
  }
}
