import { cpSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 * Copy the app-bundled plugins into ~/.solus/plugins. Runs once on startup,
 * before any agent is invoked. A clean replace (rm + copy) keeps the installed
 * plugins in lockstep with the app version — these are app-managed, not user
 * content. Best-effort: a failure here just leaves agents running without the
 * bundled plugins rather than blocking startup.
 */
export function syncBundledPlugins(): void {
  if (!existsSync(BUNDLED_PLUGINS_DIR)) return
  try {
    rmSync(PLUGINS_DIR, { recursive: true, force: true })
    cpSync(BUNDLED_PLUGINS_DIR, PLUGINS_DIR, { recursive: true })
  } catch (err) {
    log.warn(`Failed to sync bundled plugins: ${(err as Error).message}`)
  }
}

