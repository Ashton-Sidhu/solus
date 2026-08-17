import { exec, execSync } from 'child_process'
import { accessSync, constants } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

let cachedPath: string | null = null
let warmPromise: Promise<string> | null = null

// Interactive login shell runs nvm/asdf hooks; order matters for version-managed tools.
const PATH_PROBE_COMMANDS = [
  '/bin/zsh -ilc "echo $PATH"',
  '/bin/zsh -lc "echo $PATH"',
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
  const home = require('os').homedir()
  appendPathEntries(ordered, seen, `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)
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

async function computeCliPathAsync(): Promise<string> {
  const { ordered, seen } = baseEntries()
  for (const cmd of PATH_PROBE_COMMANDS) {
    try {
      const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout: 3000 })
      const discovered = stdout.trim()
      if (discovered) {
        appendPathEntries(ordered, seen, discovered)
        break
      }
    } catch {
      // Keep trying fallbacks.
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
