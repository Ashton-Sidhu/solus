import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, win32 } from 'path'
import { z } from 'zod'
import { currentVersionDir } from './version-store'

const serverLockSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(0).max(65_535),
  host: z.string().trim().min(1),
  startedAt: z.number().finite(),
})

export interface ServerLock {
  pid: number
  port: number
  host: string
  startedAt: number
}

export interface RuntimePaths {
  installDir: string
  dataDir: string
  nodePath: string
  serverEntry: string
  cliEntry: string
  lockFile: string
  pidFile: string
  logFile: string
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.SOLUS_DATA_DIR || join(home, '.solus')
}

/** Parent of `versions/` and the `current` link (`docs/plans/host-and-provider-updates.md`).
 *  On Windows it is `%LOCALAPPDATA%\solus\runtime` (`docs/plans/windows.md` §5.8). */
export function defaultRuntimeDir(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (env.SOLUS_RUNTIME_DIR) return env.SOLUS_RUNTIME_DIR
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'solus', 'runtime')
  return join(home, '.local', 'share', 'solus')
}

/** The command folder. Windows uses the same `~\.local\bin` as Claude Code's install. */
export function defaultBinDir(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (env.SOLUS_BIN_DIR) return env.SOLUS_BIN_DIR
  return (platform === 'win32' ? win32.join : join)(home, '.local', 'bin')
}

/** The stable launcher in the command folder: `solus`, or `solus.cmd` on Windows. */
export function launcherPath(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.join(binDir, 'solus.cmd') : join(binDir, 'solus')
}

/** The Node that a release ships: `bin/node`, or `bin\node.exe` on Windows. */
export function nodeBinary(installDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.join(installDir, 'bin', 'node.exe') : join(installDir, 'bin', 'node')
}

/**
 * Resolution order: an explicit override (tests, or a launcher that already
 * resolved its own root), then the runtime dir's active version, then
 * self-location for a bundle run directly out of an extracted release
 * without going through the runtime dir at all.
 */
export function resolveInstallDir(runtimeDir = defaultRuntimeDir()): string {
  if (process.env.SOLUS_INSTALL_DIR) return resolve(process.env.SOLUS_INSTALL_DIR)
  const active = currentVersionDir(runtimeDir)
  if (active) return active
  return resolve(__dirname, '../..')
}

export function runtimePaths(dataDir = defaultDataDir(), installDir = resolveInstallDir()): RuntimePaths {
  return {
    installDir,
    dataDir,
    nodePath: nodeBinary(installDir),
    serverEntry: join(installDir, 'libexec', 'server', 'standalone.js'),
    cliEntry: join(installDir, 'libexec', 'cli', 'solus.js'),
    lockFile: join(dataDir, 'server.lock'),
    pidFile: join(dataDir, 'server.pid'),
    logFile: join(dataDir, 'logs', 'solus.log'),
  }
}

/** A program in `%SystemRoot%\System32`, named by its full path so that a
 *  copy with the same name earlier on PATH (an MSYS `tar`, say) is never run. */
export function windowsSystemTool(name: string, systemRoot = process.env.SystemRoot || 'C:\\Windows'): string {
  return win32.join(systemRoot, 'System32', name)
}

export function parseLockFile(raw: string): ServerLock | null {
  try {
    const parsed = serverLockSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function readLockFile(lockFile: string): ServerLock | null {
  if (!existsSync(lockFile)) return null
  return parseLockFile(readFileSync(lockFile, 'utf-8'))
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function localConnectHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host
}
