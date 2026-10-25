import { execSync, spawn } from 'child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, win32 } from 'path'

let cachedPath: string | null = null
let warmPromise: Promise<string> | null = null

const isWindows = process.platform === 'win32'
const PATH_SEPARATOR = isWindows ? ';' : ':'

// Interactive login shell runs nvm/asdf hooks; order matters for version-managed tools.
// Single quotes: the probe runs under `/bin/sh -c`, which would expand a double-quoted
// `$PATH` to the launching process's PATH before the login shell ever starts.
// Windows has no login shell to ask: its PATH comes from the registry at logon (docs/plans/windows.md §5.2).
const PATH_PROBE_COMMANDS = isWindows ? [] : [
  "/bin/zsh -ilc 'echo $PATH'",
  "/bin/zsh -lc 'echo $PATH'",
  "/bin/bash -ilc 'echo $PATH'",
  "/bin/bash -lc 'echo $PATH'",
]

function appendPathEntries(target: string[], seen: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) return
  // Windows folders are quoted at times, and their case does not matter.
  const entries = isWindows ? windowsPathFolders(rawPath) : rawPath.split(':').map((entry) => entry.trim())
  for (const p of entries) {
    const key = isWindows ? p.toLowerCase() : p
    if (!p || seen.has(key)) continue
    seen.add(key)
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
  return { ordered, seen }
}

/** The usual install folders, for a login shell that names none of them. They
 *  come after its PATH: a version manager's folders must stay ahead of
 *  `~/.local/bin`, or a wrapper there that runs `mise x codex -- codex` finds
 *  itself again and never starts the tool. */
function appendFallbackEntries({ ordered, seen }: PathEntries): string {
  appendPathEntries(ordered, seen, isWindows ? windowsFallbackPath() : `${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)
  return ordered.join(PATH_SEPARATOR)
}

/** Where npm, Node, Bun, Volta, pnpm, scoop, and the Claude installer put commands on Windows. */
function windowsFallbackPath(): string {
  const home = homedir()
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  return [
    join(appData, 'npm'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'scoop', 'shims'),
    join(localAppData, 'Volta', 'bin'),
    join(localAppData, 'pnpm'),
  ].join(';')
}

function computeCliPathSync(): string {
  const entries = baseEntries()
  for (const cmd of PATH_PROBE_COMMANDS) {
    try {
      const discovered = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim()
      if (discovered) {
        appendPathEntries(entries.ordered, entries.seen, discovered)
        break // First login shell that answers is authoritative — don't pay for the rest.
      }
    } catch {
      // Keep trying fallbacks.
    }
  }
  return appendFallbackEntries(entries)
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
  const entries = baseEntries()
  for (const cmd of commands) {
    const discovered = await probeShell(cmd, timeoutMs)
    if (discovered) {
      appendPathEntries(entries.ordered, entries.seen, discovered)
      break // First login shell that answers is authoritative — don't pay for the rest.
    }
  }
  return appendFallbackEntries(entries)
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
  if (isWindows) return findWindowsCommand(bin, path, process.env.PATHEXT)
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

/**
 * The host's own process environment with the login-shell PATH. Only the host
 * identity and work that is the host's by nature (installing tools, probing
 * the host) use it directly; everything else asks `launchOptions`.
 */
export function hostCliEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
  }
  // A Windows env spells it `Path`; a second spelling beside it leaves the child's PATH to chance.
  if (isWindows) for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name]
  env.PATH = getCliPath()
  delete env.CLAUDECODE
  return env
}

/**
 * How to start `file` on this host. On Windows a bare name becomes the program
 * its PATH names, and a shim becomes what it starts (docs/plans/windows.md §5.1);
 * a name it cannot find is left for `spawn` to report. Elsewhere `spawn` finds it.
 */
export function startableCommand(file: string, env: NodeJS.ProcessEnv): ResolvedCommand {
  // A path names its file, unless that file is a shim Node cannot start.
  if (!isWindows || (/[\\/]/.test(file) && !/\.(?:cmd|bat)$/i.test(file))) return { file, args: [] }
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? getCliPath()
  return resolveWindowsCommand(file, path, env.PATHEXT ?? process.env.PATHEXT) ?? { file, args: [] }
}


// Program lookup on Windows (docs/plans/windows.md §5.1). A bare name there
// means one of the PATHEXT files, and Node will not start a `.cmd` shim without
// a shell, so a shim is read and the program it starts is returned. It lives in
// this module because this module loads on its own under Node.

/** How to start a program: the file to spawn and the arguments that go before the caller's. */
export interface ResolvedCommand {
  file: string
  args: string[]
}

/** The file reads the lookup needs. Tests pass their own. */
export interface CommandFiles {
  /** The lowercase names in a folder, or null when it cannot be read. */
  names(dir: string): ReadonlySet<string> | null
  read(file: string): string | null
  exists(file: string): boolean
}

/** The PATHEXT kinds Solus can start: a program, or a shim that it reads. */
const STARTABLE_EXTENSIONS = new Set(['.com', '.exe', '.bat', '.cmd'])
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
/** Git for Windows' real binaries, under its install root. */
const GIT_BINARY_FOLDERS = ['mingw64\\bin', 'ucrt64\\bin']

const listings = new Map<string, { mtimeMs: number; names: ReadonlySet<string> }>()

/** Each folder is listed once and again only when it changes, so a lookup costs one stat per PATH folder. */
export const diskCommandFiles: CommandFiles = {
  names(dir) {
    let mtimeMs: number
    try {
      mtimeMs = statSync(dir).mtimeMs
    } catch {
      listings.delete(dir)
      return null
    }
    const cached = listings.get(dir)
    if (cached?.mtimeMs === mtimeMs) return cached.names
    try {
      const names = new Set(readdirSync(dir).map((name) => name.toLowerCase()))
      listings.set(dir, { mtimeMs, names })
      return names
    } catch {
      return null
    }
  },
  read(file) {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  exists: existsSync,
}

/** The folders of a Windows PATH, without quotes, empty entries, or repeats in another case. */
export function windowsPathFolders(path: string): string[] {
  const seen = new Set<string>()
  const folders: string[] = []
  for (const entry of path.split(';')) {
    const folder = entry.trim().replace(/^"(.*)"$/, '$1').trim()
    const key = folder.toLowerCase()
    if (!folder || seen.has(key)) continue
    seen.add(key)
    folders.push(folder)
  }
  return folders
}

/** The file a bare name means on a Windows PATH, in PATHEXT order, or null. */
export function findWindowsCommand(name: string, path: string, pathext = DEFAULT_PATHEXT, files: CommandFiles = diskCommandFiles): string | null {
  if (win32.isAbsolute(name)) return files.exists(name) ? name : null
  const lowerName = name.toLowerCase()
  const extensions = pathext.split(';').map((extension) => extension.trim().toLowerCase()).filter((extension) => STARTABLE_EXTENSIONS.has(extension))
  const wanted = STARTABLE_EXTENSIONS.has(win32.extname(lowerName)) ? [lowerName] : extensions.map((extension) => lowerName + extension)
  for (const folder of windowsPathFolders(path)) {
    const names = files.names(folder)
    if (!names) continue
    const hit = wanted.find((candidate) => names.has(candidate))
    if (hit) return win32.join(folder, hit)
  }
  return null
}

/**
 * How to start a bare name on Windows, or null. A program starts as itself; a
 * shim starts the program or the script it names. A shim that names neither is
 * a miss, so the caller's error names the program and not a shell failure.
 */
export function resolveWindowsCommand(name: string, path: string, pathext = DEFAULT_PATHEXT, files: CommandFiles = diskCommandFiles): ResolvedCommand | null {
  const found = findWindowsCommand(name, path, pathext, files)
  if (!found) return null
  const extension = win32.extname(found).toLowerCase()
  if (extension === '.exe' || extension === '.com') return { file: realGitBinary(found, files), args: [] }
  const text = files.read(found)
  const target = text ? shimTarget(text, win32.dirname(found)) : null
  if (!target || !files.exists(target)) return null
  if (/\.(exe|com)$/i.test(target)) return { file: target, args: [] }
  // A script runs on the Node beside the shim, else on the PATH: the shim's own rule.
  const besideShim = win32.join(win32.dirname(found), 'node.exe')
  const node = files.exists(besideShim) ? besideShim : findWindowsCommand('node', path, pathext, files)
  return node ? { file: node, args: [target] } : null
}

/**
 * The program or script a shim starts: the last quoted path on the line that
 * passes `%*`, with `%~dp0` and the shim's own `SET "NAME=value"` variables
 * filled in. This reads the npm, pnpm, and Node `npm.cmd` templates.
 */
export function shimTarget(text: string, shimFolder: string): string | null {
  const folder = `${shimFolder}\\`
  const fill = (value: string) => value.replace(/%~dp0|%dp0%/gi, folder)
  const variables = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const set = /^\s*@?set\s+"([^=]+)=([^"]*)"/i.exec(line)
    const variable = set?.[1].toLowerCase()
    // The first value is the default; a later one is a fallback or override this lookup does not follow.
    if (set && variable && !variables.has(variable)) variables.set(variable, fill(set[2]))
  }
  const launch = lines.findLast((line) => line.includes('%*'))
  if (!launch) return null
  const quoted = [...launch.matchAll(/"([^"]+)"/g)].map((match) =>
    fill(match[1]).replace(/%([^%]+)%/g, (whole, variable: string) => variables.get(variable.toLowerCase()) ?? whole))
  const target = quoted.findLast((value) => win32.isAbsolute(value) && !value.includes('%'))
  return target ? win32.normalize(target) : null
}

/** Git for Windows' `cmd\git.exe` is a launcher that starts the real git, and each start leaks a kernel token. */
function realGitBinary(file: string, files: CommandFiles): string {
  if (!/\\cmd\\git\.exe$/i.test(file)) return file
  const root = win32.dirname(win32.dirname(file))
  for (const folder of GIT_BINARY_FOLDERS) {
    const real = win32.join(root, folder, 'git.exe')
    if (files.exists(real)) return real
  }
  return file
}

/**
 * The member's Linux user a process runs as on a host where each member is one
 * (docs/plans/member-isolation.md §4). Its group is always `solus-proj`, which the
 * member switch sets.
 */
export interface ProcessUser {
  uid: number
}

/**
 * What every process started for someone gets from the launch point
 * (docs/plans/member-isolation.md §3): its environment and, on such a host, the
 * member's user. Data, never `spawn` options: Node would ignore `user`, and the
 * process would run as the server. `launchedProcess` turns it into the command
 * line to run.
 */
export interface LaunchOptions {
  env: NodeJS.ProcessEnv
  user?: ProcessUser
}

/** One process as the launch point starts it: run `file` with `args` and `env`. */
export interface LaunchedProcess {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * The member switch (docs/plans/member-isolation.md §2 decision 1): the only
 * program that changes a process's user. The users file names it
 * (`layout.switch`); the server holds no capability.
 */
let memberSwitch: string | null = null

/** Installed from the users file, and again when it names another switch. */
export function useMemberSwitch(path: string | null): void {
  memberSwitch = path
}

/** The command line that starts `file` for this launch: through the member switch when it runs as a member's user. */
export function launchedProcess(launch: LaunchOptions, file: string, args: readonly string[]): LaunchedProcess {
  if (!launch.user) {
    const command = startableCommand(file, launch.env)
    return { file: command.file, args: [...command.args, ...args], env: launch.env }
  }
  // Never as the server: a member's process with no switch to start it does not start.
  if (!memberSwitch) throw new Error('This host names no member switch, so it cannot start a process as you.')
  return { file: memberSwitch, args: [String(launch.user.uid), '--', file, ...args], env: launch.env }
}

let actingLaunch: ((extraEnv?: NodeJS.ProcessEnv) => LaunchOptions) | null = null

/**
 * The acting scope installs how a process is launched (`vault/acting-scope.ts`),
 * so this module stays free of server imports and loads on its own under Node.
 */
export function useActingLaunch(source: (extraEnv?: NodeJS.ProcessEnv) => LaunchOptions): void {
  actingLaunch = source
}

/**
 * The launch options for a process started in the current acting scope: the
 * host's environment for the host, a member's clean one (and their user on a
 * shared host) for a member (plans/019-acting-identity.md). Throws when no scope
 * is set. A caller that can wait should prefer `currentIdentity().launchOptions()`,
 * which also names a member's commit author.
 */
export function launchOptions(extraEnv?: NodeJS.ProcessEnv): LaunchOptions {
  if (!actingLaunch) throw new Error('Solus started a process before its acting identities were loaded. This is a bug: report it with the server log.')
  return actingLaunch(extraEnv)
}

/** `file` with `args`, started in the current acting scope (`launchOptions`). */
export function launchProcess(file: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv): LaunchedProcess {
  return launchedProcess(launchOptions(extraEnv), file, args)
}
