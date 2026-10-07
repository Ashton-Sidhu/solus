import { execSync, spawn } from 'child_process'
import { accessSync, constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

let cachedPath: string | null = null
let warmPromise: Promise<string> | null = null

// Interactive login shell runs nvm/asdf hooks; order matters for version-managed tools.
// Single quotes: the probe runs under `/bin/sh -c`, which would expand a double-quoted
// `$PATH` to the launching process's PATH before the login shell ever starts.
const PATH_PROBE_COMMANDS = [
  "/bin/zsh -ilc 'echo $PATH'",
  "/bin/zsh -lc 'echo $PATH'",
  "/bin/bash -ilc 'echo $PATH'",
  "/bin/bash -lc 'echo $PATH'",
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
function probeShell(cmd: string, timeoutMs: number): Promise<string | null> {
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
    const discovered = await probeShell(cmd, timeoutMs)
    if (discovered) {
      appendPathEntries(ordered, seen, discovered)
      break // First login shell that answers is authoritative — don't pay for the rest.
    }
  }
  return ordered.join(':')
}

// The login shell's environment, between NUL-delimited markers: a profile that
// prints a banner cannot be read as a variable, and a value may hold newlines.
const ENV_START = '__SOLUS_LOGIN_ENV_START__'
const ENV_END = '__SOLUS_LOGIN_ENV_END__'
const ENV_PROBE_SCRIPT = `printf "\\0${ENV_START}\\0"; env -0; printf "${ENV_END}\\0"`
const ENV_PROBE_COMMANDS = [
  `/bin/zsh -ilc '${ENV_PROBE_SCRIPT}'`,
  `/bin/zsh -lc '${ENV_PROBE_SCRIPT}'`,
  `/bin/bash -ilc '${ENV_PROBE_SCRIPT}'`,
  `/bin/bash -lc '${ENV_PROBE_SCRIPT}'`,
]

/** The variables a Dock launch takes from the login shell. Solus's own
 *  settings and the few the agents and their tools need; never a provider
 *  API key. */
const LOGIN_ENV_NAMES = new Set([
  'SSH_AUTH_SOCK',
  'NODE_EXTRA_CA_CERTS',
  'CODEX_HOME',
  'TYPESAFE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
])

function isLoginEnvName(name: string): boolean {
  return name.startsWith('SOLUS_') || name.startsWith('OTEL_') || LOGIN_ENV_NAMES.has(name)
}

/** The allowed variables in one env probe's output that `env` does not
 *  already have. A variable the app was launched with wins, even when empty. */
export function loginShellEnvToImport(output: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const imported = new Map<string, string>()
  const fields = output.split('\0')
  const start = fields.indexOf(ENV_START)
  const end = fields.indexOf(ENV_END, start + 1)
  if (start < 0 || end < 0) return imported
  for (const entry of fields.slice(start + 1, end)) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const name = entry.slice(0, separator)
    if (!isLoginEnvName(name) || env[name] !== undefined) continue
    imported.set(name, entry.slice(separator + 1))
  }
  return imported
}

/** Copy the allowed login-shell variables into `process.env`, so a Dock launch
 *  sees what the user exported in their profile. Await it before anything reads
 *  them: `solusDir()` reads `SOLUS_DATA_DIR`, often at module evaluation. Only
 *  the desktop app calls this; a server started from a shell has them already.
 *  Answers the names it set. */
export async function importLoginShellEnv(commands: readonly string[] = ENV_PROBE_COMMANDS, timeoutMs = 3000): Promise<string[]> {
  for (const cmd of commands) {
    const output = await probeShell(cmd, timeoutMs)
    if (!output) continue
    const imported = loginShellEnvToImport(output, process.env)
    for (const [name, value] of imported) process.env[name] = value
    return [...imported.keys()]
  }
  return []
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
