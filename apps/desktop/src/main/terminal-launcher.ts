import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { resolveHomePath } from '@solus/server/platform/paths'
import { createLogger } from '@solus/server/logger'
import type { ResolvedTerminal, TerminalAppId, TerminalLaunchRequest } from '@solus/contracts/types'
import { hostCliEnv, warmCliPath } from '@solus/server/cli-env'
import type { TerminalApp } from '@solus/desktop-main/terminal-apps'

const log = createLogger('terminal-launcher', 'terminal-launcher.ts')

/**
 * "Open in terminal" on macOS and Linux: every request becomes a window in one
 * shared tmux session, shown in the terminal that already holds it, or else in
 * the terminal chosen in Settings. The parts that differ by operating system
 * (`TerminalApps`) live beside each adapter: `platform/darwin-terminal.ts` and
 * `platform/linux-terminal.ts`. Windows has no tmux (`platform/win32-terminal.ts`).
 */

const TMUX_SESSION_NAME = 'solus'
/** What a newly launched terminal runs, so it comes up attached to the session. */
export const ATTACH_COMMAND = `exec tmux attach-session -t ${TMUX_SESSION_NAME}`

/** A terminal app that already shows the session. */
export interface AttachedApp {
  /** The app's own name, also for one Solus cannot launch (Warp). */
  name: string
  /** Its catalog id, or null when it is not in the catalog. */
  id: TerminalAppId | null
  /** Bring it to the front. */
  raise(): void
}

/** The operating system's side of the shared tmux terminal. */
export interface TerminalApps {
  /** The app that draws one of these attached tmux clients, or null when this
   *  system cannot tell from the process tree. */
  attachedApp(clientPids: readonly number[]): Promise<AttachedApp | null>
  /** The terminal a launch uses for this choice, when it is installed. */
  available(id: TerminalAppId): Promise<TerminalApp | undefined>
  /** Start `app` running `command`. */
  start(app: TerminalApp, command: string): Promise<boolean>
  /** What the clients call the app. */
  displayName(app: TerminalApp): string
}

function createTmuxWindow(command: string, cwd?: string): boolean {
  if (cwd) cwd = resolveHomePath(cwd)
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION_NAME], {
      env: hostCliEnv(),
      timeout: 2000,
      stdio: 'ignore',
    })
  } catch {
    try {
      const args = ['new-session', '-d', '-s', TMUX_SESSION_NAME]
      if (cwd) args.push('-c', cwd)
      args.push(command)
      execFileSync('tmux', args, { env: hostCliEnv(), timeout: 5000 })
      log.info('tmux_session_created', { sessionName: TMUX_SESSION_NAME, command, cwd })
      return true
    } catch (createErr) {
      log.error('tmux_session_create_failed', {
        error: createErr instanceof Error ? createErr.message : String(createErr),
      })
      return false
    }
  }

  try {
    const args = ['new-window', '-t', TMUX_SESSION_NAME]
    if (cwd) args.push('-c', cwd)
    args.push(command)
    execFileSync('tmux', args, { env: hostCliEnv(), timeout: 5000 })
    log.info('tmux_window_opened', { sessionName: TMUX_SESSION_NAME, command, cwd })
    return true
  } catch (err) {
    log.error('tmux_new_window_failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** A short read-only probe. Join PATH warmup before using the CLI environment
 *  so a first inspection cannot start a second, synchronous login-shell probe. */
export async function probeOutput(file: string, args: string[], timeout: number): Promise<string | null> {
  await warmCliPath()
  return new Promise((resolve) => {
    execFile(file, args, { env: hostCliEnv(), timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

/**
 * Process ids of the tmux clients already attached to the shared session. An
 * empty list is the only reliable signal that nothing can show the new window.
 */
async function attachedClientPids(): Promise<number[]> {
  const output = await probeOutput('tmux', ['list-clients', '-t', TMUX_SESSION_NAME, '-F', '#{client_pid}'], 2000)
  if (output === null) return []
  return output
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** The shared tmux terminal, with one operating system's apps. */
export function tmuxTerminal(apps: TerminalApps) {
  /**
   * Which terminal "Open in terminal" will actually use. The clients read this to
   * name and badge the action, so it answers with what will happen rather than
   * with what is configured.
   */
  async function resolve(fallbackTerminalId: TerminalAppId): Promise<ResolvedTerminal> {
    const startedAt = performance.now()
    const clientPids = await attachedClientPids()
    if (clientPids.length > 0) {
      const attached = await apps.attachedApp(clientPids)
      const resolved: ResolvedTerminal = {
        id: attached?.id ?? null,
        name: attached?.name ?? 'Attached terminal',
        source: 'attached',
      }
      log.info('terminal_resolved', { terminalId: resolved.id, source: resolved.source, durationMs: performance.now() - startedAt })
      return resolved
    }

    const app = await apps.available(fallbackTerminalId)
    const resolved: ResolvedTerminal = {
      id: app?.id ?? null,
      name: app ? apps.displayName(app) : 'Terminal',
      source: 'fallback',
    }
    log.info('terminal_resolved', { terminalId: resolved.id, source: resolved.source, durationMs: performance.now() - startedAt })
    return resolved
  }

  /**
   * Raises the terminal that already holds the shared session. Returns false only
   * when no client is attached, because a second client would fight the first one
   * over the session's size — the long-standing "open in terminal" breakage.
   */
  async function useAttachedTerminal(): Promise<boolean> {
    const clientPids = await attachedClientPids()
    if (clientPids.length === 0) return false
    ;(await apps.attachedApp(clientPids))?.raise()
    log.info('attached_terminal_reused', { clients: clientPids.length })
    return true
  }

  /**
   * Opens a window in the shared tmux session, then shows it wherever the user is
   * already working: an attached terminal is raised, and only an unattached
   * session falls back to launching the terminal chosen in Settings.
   */
  async function launch(request: TerminalLaunchRequest): Promise<boolean> {
    const { command, fallbackTerminalId, cwd } = request
    log.info('terminal_launch', { fallbackTerminalId, command })

    if (!createTmuxWindow(command, cwd)) return false
    if (await useAttachedTerminal()) return true

    const app = await apps.available(fallbackTerminalId)
    if (!app) {
      log.warn('unknown_terminal', { fallbackTerminalId })
      return false
    }
    return apps.start(app, ATTACH_COMMAND)
  }

  return { resolve, launch }
}

/** A login shell for the shared session: the user's `$SHELL` when it exists, else `fallback`. */
export function loginShellCommand(env: NodeJS.ProcessEnv, fallback: string): string {
  const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : fallback
  return `exec '${shell.replace(/'/g, `'\\''`)}' -l`
}
