import { enableCompileCache } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Node's on-disk V8 code cache for the packaged main process.
 *
 * The main bundle and the server it hosts in-process are compiled from scratch
 * on every launch. `boot.ts` calls `startCompileCache` before it loads the main
 * bundle, so every module loaded after it — the bundle itself and the server
 * chunks it imports later — reuses the bytecode of the previous launch. The
 * first launch after an install or update builds the cache; Node keys each
 * entry by the file's path and content hash, so a stale entry is never used.
 */

export interface CompileCacheHost {
  platform: NodeJS.Platform
  xdgCacheHome: string | undefined
  homeDir: () => string
  tempDir: () => string
}

const processHost: CompileCacheHost = {
  platform: process.platform,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
  homeDir: homedir,
  tempDir: tmpdir,
}

/**
 * Linux uses the user's cache dir because `/tmp` is shared between users. The
 * macOS and Windows temp dirs are already per user.
 */
export function compileCacheDir(host: CompileCacheHost = processHost): string {
  const cacheRoot = host.platform === 'linux'
    ? host.xdgCacheHome || join(host.homeDir(), '.cache')
    : host.tempDir()
  return join(cacheRoot, 'solus', 'compile-cache')
}

/**
 * Packaged builds only. Vite rebuilds dev bundles at the same paths, and a dev
 * instance launched from the packaged app must never share its cache files.
 */
export function startCompileCache(
  isPackaged: boolean,
  enable: (directory: string) => void =enableCompileCache,
  host: CompileCacheHost = processHost,
): void {
  if (!isPackaged) return
  try {
    enable(compileCacheDir(host))
  } catch {
    // The cache is only a speedup. It must never stop the app from starting.
  }
}
