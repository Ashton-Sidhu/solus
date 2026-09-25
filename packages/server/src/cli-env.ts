import { execSync, spawn } from 'child_process'
import { accessSync, constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

let cachedPath: string | null = null
let warmPromise: Promise<string> | null = null

// Interactive login shell runs nvm/asdf hooks; order matters for version-managed tools.
const PATH_PROBE_COMMANDS = [
  '/bin/zsh -ilc "echo $PATH"',
  '/bin/zsh -lc "echo $PATH"',
  '/bin/bash -ilc "echo $PATH"',
  '/bin/bash -lc "echo $PATH"',
]

function appendPathEntries(target: string[], seen: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) return
  for (const entry of rawPath.split(':')) {
    const p = entry.trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    target.push(p)
  }
}

interface PathEntries {
  ordered: string[]
  seen: Set<string>
}

function baseEntries(): PathEntries {
  const ordered: string[] = []
  const seen = new Set<string>()
  appendPathEntries(ordered, seen, process.env.PATH)
  appendPathEntries(ordered, seen, `${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)
  return { ordered, seen }
}

function computeCliPathSync(): string {
  const { ordered, seen } = baseEntries()
  for (const cmd of PATH_PROBE_COMMANDS) {
    try {
      const discovered = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim()
      if (discovered) {
        appendPathEntries(ordered, seen, discovered)
        break // First login shell that answers is authoritative — don't pay for the rest.
      }
    } catch {
      // Keep trying fallbacks.
    }
  }
  return ordered.join(':')
}

/** One probe's stdout, or null when it printed nothing, failed, or ran out of
 *  time. Stdin is closed from the start: an interactive shell with an open
 *  stdin waits on it instead of exiting, and a probe that waits out its whole
 *  timeout is what let the first RPC beat the warmup. */
function probeShellPath(cmd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs })
    let stdout = ''
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 && stdout.trim() ? stdout.trim() : null))
  })
}

/** Exported for its test; production callers go through `warmCliPath`. */
export async function computeCliPathAsync(commands: readonly string[] = PATH_PROBE_COMMANDS, timeoutMs = 3000): Promise<string> {
  const { ordered, seen } = baseEntries()
  for (const cmd of commands) {
    const discovered = await probeShellPath(cmd, timeoutMs)
    if (discovered) {
      appendPathEntries(ordered, seen, discovered)
      break // First login shell that answers is authoritative — don't pay for the rest.
    }
  }
  return ordered.join(':')
}

/** Kick off PATH resolution off the main thread at app boot so the login-shell
 *  probes are warm before the first RPC needs them. Idempotent. */
export function warmCliPath(): Promise<string> {
  if (cachedPath) return Promise.resolve(cachedPath)
  if (!warmPromise) {
    warmPromise = computeCliPathAsync().then((p) => {
      cachedPath = p
      return p
    })
  }
  return warmPromise
}

export function getCliPath(): string {
  if (cachedPath) return cachedPath
  // The first RPC beat the async warmup — pay the synchronous probe once. The
  // warmup (if in flight) will resolve to the same value and no-op.
  cachedPath = computeCliPathSync()
  return cachedPath
}

/** Walk a PATH ourselves, the way `which` is supposed to — the fallback for
 *  callers that can't afford to believe a probe which answers "nothing". */
export function findOnPath(bin: string, path: string): string | null {
  for (const dir of path.split(':')) {
    if (!dir) continue
    const candidate = join(dir, bin)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here — keep walking.
    }
  }
  return null
}

export function getCliEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PATH: getCliPath(),
  }
  delete env.CLAUDECODE
  return env
}
