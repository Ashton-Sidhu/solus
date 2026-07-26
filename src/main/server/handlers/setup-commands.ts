import { execFileSync } from 'child_process'
import { existsSync } from 'fs'

import { basename, join } from 'path'
import type { CloneProtocol, GitInstallCommand, SetupAgent } from '../../../shared/types'
import { getCliEnv } from '../../cli-env'

/**
 * The commands host setup runs, and the parsing that decides them. Everything
 * here is pure or probe-only, so it stays unit-testable and can never be steered
 * by a client-supplied fragment: argv is built from fixed tables, never from
 * interpolated input.
 */

const CLAUDE_NPM_PACKAGE = '@anthropic-ai/claude-code'
const CODEX_NPM_PACKAGE = '@openai/codex'
const CLAUDE_INSTALL_SCRIPT = 'curl -fsSL https://claude.ai/install.sh | bash -s'

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

export interface GitInstallCommandOptions extends BuildInstallCommandOptions {
  platform?: NodeJS.Platform
  isRoot?: boolean
}

export interface GitInstallCommandSpec extends GitInstallCommand {
  command: string
  args: string[]
}

/** Probed in order; the first manager present on the host wins. */
const LINUX_GIT_INSTALLERS = [
  { command: 'apt-get', args: ['install', '-y', 'git'] },
  { command: 'dnf', args: ['install', '-y', 'git'] },
  { command: 'pacman', args: ['-S', '--noconfirm', 'git'] },
  { command: 'apk', args: ['add', 'git'] },
] as const

export interface CloneUrlInfo {
  cloneUrl: string
  repoName: string
}

/**
 * npm is the primary installer because both supported CLIs publish official npm
 * packages and the existing CLI env already discovers version-manager PATHs.
 * Claude keeps its official install-script fallback for hosts without npm.
 */
export function buildAgentInstallCommand(agent: SetupAgent, opts: BuildInstallCommandOptions = {}): InstallCommandSpec {
  const hasCommand = opts.hasCommand ?? commandExists
  if (agent === 'claude') {
    // if (hasCommand('npm')) {
    //   return {
    //     command: 'npm',
    //     args: ['install', '-g', CLAUDE_NPM_PACKAGE],
    //     display: `npm install -g ${CLAUDE_NPM_PACKAGE}`,
    //     strategy: 'npm',
    //   }
    // }
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
  if (cloneUrl.length > 2048 || /[\s\x00-\x1f\x7f]/.test(cloneUrl)) {
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
 * How git gets installed on this host. Homebrew first — it needs no elevation on
 * either platform; the distro managers all do, so they are only auto-runnable
 * when Solus already runs as root. Everything else is handed over as text.
 */
export function buildGitInstallCommand(opts: GitInstallCommandOptions = {}): GitInstallCommandSpec | null {
  const platform = opts.platform ?? process.platform
  const hasCommand = opts.hasCommand ?? commandExists
  const isRoot = opts.isRoot ?? process.getuid?.() === 0

  if (hasCommand('brew')) {
    return { command: 'brew', args: ['install', 'git'], display: 'brew install git', autoRunnable: true }
  }

  if (platform === 'darwin') {
    // The CLT installer is a GUI prompt on the host's own screen; Solus can't drive it.
    return { command: 'xcode-select', args: ['--install'], display: 'xcode-select --install', autoRunnable: false }
  }

  const manager = LINUX_GIT_INSTALLERS.find((candidate) => hasCommand(candidate.command))
  if (!manager) return null
  return {
    command: isRoot ? manager.command : 'sudo',
    args: isRoot ? [...manager.args] : [manager.command, ...manager.args],
    display: `${isRoot ? '' : 'sudo '}${manager.command} ${manager.args.join(' ')}`,
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
  try {
    const url = new URL(cloneUrl)
    if (url.protocol !== 'https:' || !isValidCloneHost(url.hostname) || url.username || url.password) return null
    if (!/^\/[A-Za-z0-9._~/-]+\.git$/.test(url.pathname)) return null
    return { cloneUrl, repoName: repoNameFromPath(url.pathname) }
  } catch {
    return null
  }
}

function parseSshCloneUrl(cloneUrl: string): CloneUrlInfo | null {
  try {
    const url = new URL(cloneUrl)
    if (url.protocol !== 'ssh:' || !url.username || !isValidCloneHost(url.hostname)) return null
    if (!/^\/[A-Za-z0-9._~/-]+\.git$/.test(url.pathname)) return null
    return { cloneUrl, repoName: repoNameFromPath(url.pathname) }
  } catch {
    return null
  }
}

function parseScpLikeCloneUrl(cloneUrl: string): CloneUrlInfo | null {
  const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+\.git)$/.exec(cloneUrl)
  if (!match || !isValidCloneHost(match[2]) || !match[3].includes('/')) return null
  return { cloneUrl, repoName: repoNameFromPath(match[3]) }
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
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+\.git)$/.exec(cloneUrl)
  if (scp) return { host: scp[1], repoPath: scp[2] }
  try {
    const url = new URL(cloneUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null
    return { host: url.hostname, repoPath: url.pathname.replace(/^\/+/, '') }
  } catch {
    return null
  }
}
