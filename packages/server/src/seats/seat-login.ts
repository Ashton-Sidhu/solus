import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SeatProvider } from '@solus/contracts/seats'
import { getCliEnv } from '../cli-env'

/**
 * Where a provider CLI looks for its login. A member's seat names a directory; the
 * host login (`home === null`) leaves the CLI on its defaults, so nothing about a
 * single-person host changes, keychain naming on macOS included.
 */
export function seatEnv(provider: SeatProvider, home: string | null): NodeJS.ProcessEnv {
  if (home === null) return {}
  return provider === 'claude-code' ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home }
}

/**
 * Whether a login is present. Claude keeps its credential wherever the platform
 * stores it (a file on Linux, the keychain on macOS), so its own status command is
 * the only honest check; Codex writes `auth.json` into its home.
 */
export function providerLoginConnected(
  provider: SeatProvider,
  home: string | null,
  probe: (command: string, args: string[], env: NodeJS.ProcessEnv) => boolean = probeSucceeds,
): boolean {
  if (provider === 'codex') {
    const codexHome = home ?? hostCodexHome()
    return existsSync(join(codexHome, 'auth.json'))
  }
  // `.claude.json` is durable client state, not a credential: Claude keeps it
  // after logout with `loggedIn: false`. Let the CLI interpret every supported
  // credential backend and answer through its documented status exit code.
  return probe('claude', ['auth', 'status'], getCliEnv(seatEnv(provider, home)))
}

/** The host's own provider homes: what the CLIs read with no seat variable set. */
export function hostClaudeDir(): string {
  return join(homedir(), '.claude')
}

export function hostCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

function probeSucceeds(command: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(command, args, { env, timeout: 5_000, stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}
