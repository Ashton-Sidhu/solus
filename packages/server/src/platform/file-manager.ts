import { execFile, spawn } from 'child_process'
import { stat } from 'fs/promises'
import type { FileManagerKind } from '@solus/contracts/types'
import { findOnPath, hostCliEnv } from '../cli-env'
import { createLogger } from '../logger'

/**
 * Opens a folder in the host's own file manager, with the commands t3code uses
 * (`apps/server/src/process/externalLauncher.ts` in pingdotgg/t3code): `open`
 * on macOS, `explorer` on Windows, `explorer.exe` from WSL, and `xdg-open` on
 * a Linux desktop. The command runs on the host, so the folder opens on the
 * host's screen — only a local connection may ask (`host.local.window`).
 */

const log = createLogger('main', 'file-manager')

/** The facts the choice depends on, passed in so a test can name any host. */
export interface FileManagerHost {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** The PATH the command is found on. */
  path: string
  /** Whether the Linux desktop names an application for `inode/directory`. */
  hasDirectoryHandler: () => Promise<boolean>
}

/** How long `xdg-mime` may take before the host counts as having no folder handler. */
const LINUX_DIRECTORY_HANDLER_PROBE_MS = 2000

/** WSL whose Windows desktop is the user's, not an SSH session or a container inside it. */
function usesWindowsHostFromWsl({ platform, env }: FileManagerHost): boolean {
  return platform === 'linux'
    && (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined)
    && env.SSH_CONNECTION === undefined
    && env.SSH_TTY === undefined
    && env.container === undefined
}

function hasGraphicalLinuxSession(env: NodeJS.ProcessEnv): boolean {
  return [env.DISPLAY, env.WAYLAND_DISPLAY].some((value) => !!value?.trim())
}

function preferredCommand(host: FileManagerHost): string | undefined {
  switch (host.platform) {
    case 'darwin': return 'open'
    case 'win32': return 'explorer'
    default:
      if (usesWindowsHostFromWsl(host)) return host.env.WSL_DISTRO_NAME?.trim() ? 'explorer.exe' : undefined
      return hasGraphicalLinuxSession(host.env) ? 'xdg-open' : undefined
  }
}

/**
 * A graphical session and an `xdg-open` on PATH do not prove that opening a
 * folder does anything: with no `inode/directory` handler, `xdg-open` fails
 * after it has detached, and the user sees nothing happen.
 */
function hasLinuxDirectoryHandler(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!findOnPath('xdg-mime', env.PATH ?? '')) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('xdg-mime', ['query', 'default', 'inode/directory'], {
      encoding: 'utf8',
      env,
      timeout: LINUX_DIRECTORY_HANDLER_PROBE_MS,
    }, (error, stdout) => resolve(!error && stdout.trim().length > 0))
  })
}

async function isUsableCommand(command: string, host: FileManagerHost): Promise<boolean> {
  // `explorer` is part of Windows; a PATH walk there needs PATHEXT, and adds nothing.
  if (host.platform === 'win32') return true
  if (!findOnPath(command, host.path)) return false
  return command !== 'xdg-open' || await host.hasDirectoryHandler()
}

/**
 * The command that opens a folder on this host, or undefined when it has no
 * file manager to show (a headless Linux box). WSL prefers Windows Explorer,
 * but keeps WSLg's Linux file manager when Explorer is out of reach.
 */
export async function resolveFileManagerCommand(host: FileManagerHost): Promise<string | undefined> {
  const command = preferredCommand(host)
  if (command && await isUsableCommand(command, host)) return command
  if (usesWindowsHostFromWsl(host) && hasGraphicalLinuxSession(host.env) && await isUsableCommand('xdg-open', host)) {
    return 'xdg-open'
  }
  return undefined
}

/** Which file manager a command opens, so a client can name it and show its icon. */
export function fileManagerKindOf(command: string): FileManagerKind {
  if (command === 'open') return 'finder'
  if (command === 'explorer' || command === 'explorer.exe') return 'file-explorer'
  return 'files'
}

/** Explorer reads a WSL folder through the distro's UNC share. */
function wslExplorerPath(target: string, distroName: string): string {
  const relativePath = target.replace(/^\/+/, '').replaceAll('/', '\\')
  return `\\\\wsl.localhost\\${distroName}${relativePath ? `\\${relativePath}` : ''}`
}

export function fileManagerArgs(target: string, command: string, env: NodeJS.ProcessEnv): string[] {
  return command === 'explorer.exe' && env.WSL_DISTRO_NAME !== undefined
    ? [wslExplorerPath(target, env.WSL_DISTRO_NAME)]
    : [target]
}

/** The host's own environment: the folder opens on the host's desktop, for its owner. */
function thisHost(): FileManagerHost {
  const env = hostCliEnv()
  return {
    platform: process.platform,
    env,
    path: env.PATH ?? '',
    hasDirectoryHandler: () => hasLinuxDirectoryHandler(env),
  }
}

// The desktop a host runs under does not change while it runs, and the
// capability is read on every connect: resolve it once.
let hostCommand: Promise<string | undefined> | null = null
function hostFileManagerCommand(): Promise<string | undefined> {
  hostCommand ??= resolveFileManagerCommand(thisHost()).catch(() => undefined)
  return hostCommand
}

/** The file manager this host opens folders in, for its capabilities. */
export async function hostFileManager(): Promise<FileManagerKind | undefined> {
  const command = await hostFileManagerCommand()
  return command ? fileManagerKindOf(command) : undefined
}

/** Opens a folder on this host's screen. False when it is no folder or nothing can show it. */
export async function openInFileManager(target: string): Promise<boolean> {
  const isDirectory = await stat(target).then((entry) => entry.isDirectory(), () => false)
  if (!isDirectory) return false
  const command = await hostFileManagerCommand()
  if (!command) return false
  const host = thisHost()
  return new Promise((resolve) => {
    // Detached, like t3code: Explorer exits non-zero even when it opens the
    // folder, so only a failure to start is a failure.
    const child = spawn(command, fileManagerArgs(target, command, host.env), {
      detached: true,
      stdio: 'ignore',
      env: host.env,
    })
    child.on('error', (error) => {
      log.warn('open_in_file_manager_failed', { command, error: error.message })
      resolve(false)
    })
    child.on('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
