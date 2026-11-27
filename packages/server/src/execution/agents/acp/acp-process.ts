import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../../../logger'
import { resolveHomePath } from '../../../platform/paths'
import { launchedProcess, memberUserOfCommand, type ProcessUser } from '../../../cli-env'

const log = createLogger('AcpBackend', 'acp-process.ts')

const TEMP_PREFIX = 'run-'
/** A stopped agent gets this long to exit before it is killed. */
const STOP_GRACE_MS = 2_000

export type SpawnAgent = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess

export const defaultSpawn: SpawnAgent = (file, args, options) => nodeSpawn(file, args, {
  cwd: resolveHomePath(options.cwd),
  env: options.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  windowsHide: true,
})

/** Removes a process's temp folder in the background: agy unpacks about 1 GB into it. */
export function removeTemp(folder: string): void {
  void rm(folder, { recursive: true, force: true }).catch((error: Error) => log.warn('acp_temp_remove_failed', { folder, error: error.message }))
}

/**
 * A new temp folder for one process in `root`. The first in a root of this
 * backend first removes what earlier processes left after a crash: no
 * process of this backend uses them yet.
 */
export function allocatePrivateTemp(root: string, sweptRoots: Set<string>): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!sweptRoots.has(root)) {
    sweptRoots.add(root)
    for (const entry of readdirSync(root)) if (entry.startsWith(TEMP_PREFIX)) removeTemp(join(root, entry))
  }
  return mkdtempSync(join(root, TEMP_PREFIX))
}

export function stderrSummary(lines: string[]): string {
  const tail = lines.slice(-3).join('\n').trim()
  return tail ? `\n${tail}` : ''
}

/**
 * Signals a member's process group as that member, through the member switch: the
 * server may not signal another user's process (EPERM), so an agent that runs as a
 * member would keep running after Stop, an idle close, or the host's shutdown.
 */
function signalAsMember(user: ProcessUser, group: number, name: NodeJS.Signals): void {
  const run = launchedProcess({ env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, user }, 'kill', [`-${name.replace(/^SIG/, '')}`, '--', `-${group}`])
  const result = spawnSync(run.file, run.args, { env: run.env, stdio: 'ignore', timeout: 5_000 })
  // Status 1: the group has already gone.
  if (result.status !== 0 && result.status !== 1) log.warn('acp_member_signal_failed', { group, signal: name, status: result.status, error: result.error?.message ?? null })
}

/** Stops only the process this backend started, with its process group. */
export function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const member = memberUserOfCommand(child.spawnargs ?? [])
  const signal = (name: NodeJS.Signals) => {
    if (process.platform !== 'win32' && child.pid) {
      if (member) return signalAsMember(member, child.pid, name)
      try { process.kill(-child.pid, name); return } catch { /* The group is gone; signal the child. */ }
    }
    child.kill(name)
  }
  child.stdin?.end()
  signal('SIGTERM')
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) signal('SIGKILL') }, STOP_GRACE_MS)
  timer.unref?.()
}
