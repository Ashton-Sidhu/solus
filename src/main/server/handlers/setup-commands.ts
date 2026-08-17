import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'

import { basename, join } from 'path'
import type { CloneProtocol, PackageInstallCommand, SetupAgent } from '../../../shared/types'
import { getCliEnv } from '../../cli-env'

/**
 * The commands host setup runs, and the parsing that decides them. Everything
 * here is pure or probe-only, so it stays unit-testable and can never be steered
 * by a client-supplied fragment: argv is built from fixed tables, never from
 * interpolated input.
 */

const CODEX_NPM_PACKAGE = '@openai/codex'
const CLAUDE_INSTALL_SCRIPT = 'curl -fsSL https://claude.ai/install.sh | bash -s'
const GH_APT_INSTALL_SCRIPT = [
  'set -eu',
  'if ! command -v wget >/dev/null 2>&1; then apt-get update; apt-get install -y wget; fi',
  'install -d -m 755 /etc/apt/keyrings',
  'keyring=$(mktemp)',
  'trap \'rm -f "$keyring"\' EXIT',
  'wget -nv -O "$keyring" https://cli.github.com/packages/githubcli-archive-keyring.gpg',
  'install -m 644 "$keyring" /etc/apt/keyrings/githubcli-archive-keyring.gpg',
  'install -d -m 755 /etc/apt/sources.list.d',
  'architecture=$(dpkg --print-architecture)',
  'printf \'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\\n\' "$architecture" > /etc/apt/sources.list.d/github-cli.list',
  'apt-get update',
  'apt-get install -y gh',
].join('\n')

export function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { encoding: 'utf8', env: getCliEnv(), timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export interface InstallCommandSpec {
  command: string
  args: string[]
  display: string
  strategy: 'npm' | 'claude-install-script'
}

export interface BuildInstallCommandOptions {
  hasCommand?: (command: string) => boolean
}

export interface AgentInstallCompatibilityOptions {
  platform?: NodeJS.Platform
  arch?: string
  cpuInfo?: string
}

/** The packages host setup knows how to put on a host by itself. */
export type InstallablePackage = 'git' | 'gh'

export interface PackageInstallCommandOptions extends BuildInstallCommandOptions {
  platform?: NodeJS.Platform
  isRoot?: boolean
  canElevate?: boolean
}

export interface PackageInstallCommandSpec extends PackageInstallCommand {
  command: string
  args: string[]
}

/** True only when sudo can elevate this service account without opening a prompt. */
export function canSudoNonInteractive(): boolean {
  try {
    execFileSync('sudo', ['-n', 'true'], {
      env: getCliEnv(),
      stdio: 'ignore',
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}

/** Probed in order; the first manager present on the host wins. */
const LINUX_PACKAGE_INSTALLERS = [
  { command: 'apt-get', args: (pkg: string) => ['install', '-y', pkg] },
  { command: 'dnf', args: (pkg: string) => ['install', '-y', pkg] },
  { command: 'pacman', args: (pkg: string) => ['-S', '--noconfirm', pkg] },
  { command: 'apk', args: (pkg: string) => ['add', pkg] },
] as const

/** The GitHub CLI ships under a longer name on the distros that spell it out. */
const PACKAGE_NAMES = {
  git: {},
  gh: { pacman: 'github-cli', apk: 'github-cli' },
} satisfies Record<InstallablePackage, Partial<Record<string, string>>>

export interface CloneUrlInfo {
  cloneUrl: string
  repoName: string
}

/**
 * Anthropic's native Linux x64 executable is built with Bun. Even Bun's
 * baseline x64 target requires SSE4.2, which old/default KVM CPU profiles may
 * hide despite running on newer physical hardware.
 */
export function agentInstallCompatibilityError(
  agent: SetupAgent,
  opts: AgentInstallCompatibilityOptions = {},
): string | null {
  if (agent !== 'claude') return null
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  if (platform !== 'linux' || arch !== 'x64') return null

  let cpuInfo = opts.cpuInfo
  if (cpuInfo === undefined) {
    try {
      cpuInfo = readFileSync('/proc/cpuinfo', 'utf8')
    } catch {
      return null
    }
  }
  if (/(?:^|\s)sse4_2(?:\s|$)/m.test(cpuInfo)) return null
  return 'Claude’s native installer requires SSE4.2, but this host’s CPU profile does not expose it. For a KVM/QEMU host, enable CPU passthrough (host) or an x86-64-v2-or-newer CPU model, then try again.'
}

/**
 * Claude uses Anthropic's recommended native installer. Codex publishes an
 * official npm package and the existing CLI env discovers version-manager PATHs.
 */
export function buildAgentInstallCommand(agent: SetupAgent, opts: BuildInstallCommandOptions = {}): InstallCommandSpec {
  const hasCommand = opts.hasCommand ?? commandExists
  if (agent === 'claude') {
    return {
      command: 'bash',
      args: ['-lc', CLAUDE_INSTALL_SCRIPT],
      display: CLAUDE_INSTALL_SCRIPT,
      strategy: 'claude-install-script',
    }
  }

  if (!hasCommand('npm')) throw new Error('npm is required to install Codex CLI.')
  return {
    command: 'npm',
    args: ['install', '-g', CODEX_NPM_PACKAGE],
    display: `npm install -g ${CODEX_NPM_PACKAGE}`,
    strategy: 'npm',
  }
}

export function validateCloneUrl(raw: string): CloneUrlInfo {
  const cloneUrl = raw.trim()
  if (!cloneUrl) throw new Error('Clone URL is required.')
  const hasControlCharacter = [...cloneUrl].some((character) => {
    const code = character.charCodeAt(0)
    return /\s/.test(character) || code <= 31 || code === 127
  })
  if (cloneUrl.length > 2048 || hasControlCharacter) {
    throw new Error('Clone URL must not contain whitespace or control characters.')
  }

  const https = parseHttpsCloneUrl(cloneUrl)
  if (https) return https

  const sshUrl = parseSshCloneUrl(cloneUrl)
  if (sshUrl) return sshUrl

  const scpLike = parseScpLikeCloneUrl(cloneUrl)
  if (scpLike) return scpLike

  throw new Error('Clone URL must be a well-formed https or ssh git URL ending in .git.')
}

/**
 * How a package gets installed on this host. Homebrew first — it needs no
 * elevation on either platform; the distro managers all do, so they are only
 * auto-runnable when Solus already runs as root. Everything else is handed over
 * as text.
 */
export function buildPackageInstallCommand(
  pkg: InstallablePackage,
  opts: PackageInstallCommandOptions = {},
): PackageInstallCommandSpec | null {
  const platform = opts.platform ?? process.platform
  const hasCommand = opts.hasCommand ?? commandExists
  const isRoot = opts.isRoot ?? process.getuid?.() === 0

  if (hasCommand('brew')) {
    return { command: 'brew', args: ['install', pkg], display: `brew install ${pkg}`, autoRunnable: true }
  }

  if (platform === 'darwin') {
    // The Command Line Tools carry git, and their installer is a GUI prompt on
    // the host's own screen that Solus can't drive. Nothing there ships `gh`.
    if (pkg !== 'git') return null
    return { command: 'xcode-select', args: ['--install'], display: 'xcode-select --install', autoRunnable: false }
  }

  const manager = LINUX_PACKAGE_INSTALLERS.find((candidate) => hasCommand(candidate.command))
  if (!manager) return null
  const canElevate = !isRoot && (opts.canElevate ?? canSudoNonInteractive())

  // GitHub recommends its maintained apt repository rather than the stale
  // Debian/Ubuntu community package. A bare `apt-get install gh` also fails
  // with exit 100 on minimal hosts whose package index has never seen `gh`.
  if (pkg === 'gh' && manager.command === 'apt-get') {
    const display = 'Install gh from GitHub’s official apt repository'
    if (isRoot) {
      return {
        command: 'sh',
        args: ['-c', GH_APT_INSTALL_SCRIPT],
        display,
        autoRunnable: true,
      }
    }
    return {
      command: 'sudo',
      args: ['-n', 'sh', '-c', GH_APT_INSTALL_SCRIPT],
      display,
      autoRunnable: canElevate,
    }
  }

  const args = manager.args(PACKAGE_NAMES[pkg][manager.command] ?? pkg)
  if (canElevate) {
    return {
      command: 'sudo',
      args: ['-n', manager.command, ...args],
      display: `sudo -n ${manager.command} ${args.join(' ')}`,
      autoRunnable: true,
    }
  }
  return {
    command: isRoot ? manager.command : 'sudo',
    args: isRoot ? args : [manager.command, ...args],
    display: `${isRoot ? '' : 'sudo '}${manager.command} ${args.join(' ')}`,
    autoRunnable: isRoot,
  }
}

/**
 * Retargets a clone URL at the protocol the user picked. HTTPS is the default
 * because it rides the host's stored token; SSH needs a key on that host.
 */
export function applyCloneProtocol(cloneUrl: string, protocol: CloneProtocol | undefined): string {
  if (!protocol) return cloneUrl
  const parsed = parseCloneUrlParts(cloneUrl)
  if (!parsed) return cloneUrl
  return protocol === 'https'
    ? `https://${parsed.host}/${parsed.repoPath}`
    : `git@${parsed.host}:${parsed.repoPath}`
}

export interface CloneDestinationOptions {
  /** Already host-absolute — the caller expands `~` on the host that owns it. */
  destination?: string
  name?: string
  repoName: string
  projectsRoot: string
  exists?: (candidate: string) => boolean
}

/**
 * An explicit destination is taken as given (so "Change…" in the dialog means
 * it); otherwise the repo lands beside the host's other projects under a name
 * that doesn't collide with what's already there.
 */
export function resolveCloneDestination(opts: CloneDestinationOptions): string {
  const explicit = opts.destination?.trim()
  if (explicit) return explicit
  const dirName = safeProjectDirName(opts.name?.trim() || opts.repoName)
  return uniqueProjectPath(opts.projectsRoot, dirName, opts.exists)
}

export function safeProjectDirName(raw: string): string {
  const base = raw.trim().replace(/\.git$/i, '')
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (!cleaned || /^\.+$/.test(cleaned)) return 'project'
  return cleaned.startsWith('.') ? `project-${cleaned.slice(1)}` : cleaned
}

function parseHttpsCloneUrl(cloneUrl: string): CloneUrlInfo | null {
  return parseProtocolCloneUrl(cloneUrl, 'https:', (url) => !url.username && !url.password)
}

function parseSshCloneUrl(cloneUrl: string): CloneUrlInfo | null {
  return parseProtocolCloneUrl(cloneUrl, 'ssh:', (url) => !!url.username)
}

function parseProtocolCloneUrl(
  cloneUrl: string,
  protocol: string,
  acceptsUserInfo: (url: URL) => boolean,
): CloneUrlInfo | null {
  try {
    const url = new URL(cloneUrl)
    if (url.protocol !== protocol || !acceptsUserInfo(url) || !isValidCloneHost(url.hostname)) return null
    if (!/^\/[A-Za-z0-9._~/-]+\.git$/.test(url.pathname)) return null
    return { cloneUrl, repoName: repoNameFromPath(url.pathname) }
  } catch {
    return null
  }
}

function parseScpLikeCloneUrl(cloneUrl: string): CloneUrlInfo | null
function parseScpLikeCloneUrl(cloneUrl: string, includeParts: true): (CloneUrlInfo & { host: string; repoPath: string }) | null
function parseScpLikeCloneUrl(
  cloneUrl: string,
  includeParts = false,
): CloneUrlInfo | (CloneUrlInfo & { host: string; repoPath: string }) | null {
  const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+\.git)$/.exec(cloneUrl)
  if (!match || !isValidCloneHost(match[2]) || !match[3].includes('/')) return null
  const info = { cloneUrl, repoName: repoNameFromPath(match[3]) }
  return includeParts ? { ...info, host: match[2], repoPath: match[3] } : info
}


function repoNameFromPath(value: string): string {
  return basename(value).replace(/\.git$/i, '') || 'project'
}


export function isValidCloneHost(host: string): boolean {
  return /^[A-Za-z0-9.-]+$/.test(host) && !host.startsWith('.') && !host.endsWith('.')
}


function uniqueProjectPath(root: string, name: string, exists: (candidate: string) => boolean = existsSync): string {
  let candidate = join(root, name)
  let suffix = 2
  while (exists(candidate)) {
    candidate = join(root, `${name}-${suffix}`)
    suffix++
  }
  return candidate
}

/** `host` + `owner/repo.git` for the forms `validateCloneUrl` accepts, so a URL can change protocol. */
export function parseCloneUrlParts(cloneUrl: string): { host: string; repoPath: string } | null {
  const scp = parseScpLikeCloneUrl(cloneUrl, true)
  if (scp) return { host: scp.host, repoPath: scp.repoPath }
  try {
    const url = new URL(cloneUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null
    return { host: url.hostname, repoPath: url.pathname.replace(/^\/+/, '') }
  } catch {
    return null
  }
}
