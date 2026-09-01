import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { z } from 'zod'

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

export function resolveInstallDir(): string {
  if (process.env.SOLUS_INSTALL_DIR) return resolve(process.env.SOLUS_INSTALL_DIR)
  return resolve(__dirname, '../..')
}

export function runtimePaths(dataDir = defaultDataDir()): RuntimePaths {
  const installDir = resolveInstallDir()
  return {
    installDir,
    dataDir,
    nodePath: join(installDir, 'bin', 'node'),
    serverEntry: join(installDir, 'libexec', 'server', 'standalone.js'),
    cliEntry: join(installDir, 'libexec', 'cli', 'solus.js'),
    lockFile: join(dataDir, 'server.lock'),
    pidFile: join(dataDir, 'server.pid'),
    logFile: join(dataDir, 'logs', 'solus.log'),
  }
}

export function parseLockFile(raw: string): ServerLock | null {
  try {
    const parsed = serverLockSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function parsePidFile(raw: string): number | null {
  const pid = Number(raw.trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  return pid
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
