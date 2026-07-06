import { existsSync } from 'node:fs'
import { cp, mkdir, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('Plugins', 'plugins.ts')

/** App-bundled source. Lives under resources/ — inside app.asar in production,
 *  but still readable by Node's asar-aware fs (the CLIs that consume them are
 *  separate processes that cannot, which is why we copy them out below). */
const BUNDLED_PLUGINS_DIR = join(__dirname, '../../resources/plugins')

/** Installed destination — co-located with the rest of Solus's config so the
 *  Claude Code and Codex CLIs can load plugins from a real filesystem path. */
export const PLUGINS_DIR = join(homedir(), '.solus', 'plugins')
export const SOLUS_PLUGINS_DIR = join(PLUGINS_DIR, 'solus')

/**
 * Link the app-bundled plugins into ~/.solus/plugins. Runs once on startup,
 * before any agent is invoked. In dev this keeps agents pointed at the working
 * tree so plugin changes are immediately testable. Packaged builds still copy
 * from app.asar because external CLIs cannot follow a symlink into asar.
 * Best-effort: a failure here just leaves agents running without the bundled
 * plugins rather than blocking startup.
 */
export async function syncBundledPlugins(): Promise<void> {
  if (!existsSync(BUNDLED_PLUGINS_DIR)) return
  try {
    await rm(PLUGINS_DIR, { recursive: true, force: true })
    await mkdir(dirname(PLUGINS_DIR), { recursive: true })
    if (BUNDLED_PLUGINS_DIR.includes('.asar')) {
      await cp(BUNDLED_PLUGINS_DIR, PLUGINS_DIR, { recursive: true })
      return
    }
    await symlink(BUNDLED_PLUGINS_DIR, PLUGINS_DIR, 'dir')
  } catch (err) {
    log.warn(`Failed to sync bundled plugins: ${(err as Error).message}`)
  }
}
