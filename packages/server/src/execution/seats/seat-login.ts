import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SeatProvider } from '@solus/contracts/seats'
import { launchProcess, type LaunchedProcess } from '../../cli-env'
import { memberUsers } from '../../host/member-users'
import { antigravitySignedIn, hostAntigravityProfile } from '../agents/acp/antigravity-auth'

/**
 * Where a provider CLI looks for its login. A member's seat names a directory; the
 * host login (`home === null`) leaves the CLI on its defaults, so nothing about a
 * single-person host changes, keychain naming on macOS included. Where each member
 * is their own Linux user, their CLI also keeps its defaults under their `HOME`, as
 * on any machine: the host object links their login there (docs/plans/member-isolation.md §5).
 */
export function seatEnv(provider: SeatProvider, home: string | null): NodeJS.ProcessEnv {
  if (home === null || memberUsers()) return {}
  return { [SEAT_HOME_VARIABLES[provider]]: home }
}

/** The variable each CLI reads its home from. */
const SEAT_HOME_VARIABLES = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  antigravity: 'GEMINI_HOME',
} as const satisfies Record<SeatProvider, string>

/**
 * Whether a login is present. Claude keeps its credential wherever the platform
 * stores it (a file on Linux, the keychain on macOS), so its own status command is
 * the only honest check; Codex writes `auth.json` into its home.
 */
export type LoginProbe = (run: LaunchedProcess) => Promise<boolean>

export async function providerLoginConnected(
  provider: SeatProvider,
  home: string | null,
  probe: LoginProbe = probeSucceeds,
): Promise<boolean> {
  if (provider === 'codex') {
    const codexHome = home ?? hostCodexHome()
    return existsSync(join(codexHome, 'auth.json'))
  }
  if (provider === 'antigravity') {
    // Solus's record of the profile's sign-in says where its credential is (§7).
    return antigravitySignedIn(home ?? hostAntigravityProfile())
  }
  // `.claude.json` is durable client state, not a credential: Claude keeps it
  // after logout with `loggedIn: false`. Let the CLI interpret every supported
  // credential backend and answer through its documented status exit code.
  return probe(launchProcess('claude', ['auth', 'status'], seatEnv(provider, home)))
}

/** The host's own provider homes: what the CLIs read with no seat variable set. */
export function hostClaudeDir(): string {
  return join(homedir(), '.claude')
}

export function hostCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

/** The CLI is a whole process starting up — a few hundred milliseconds — so it
 *  runs off the main thread; a synchronous spawn here held every request. */
function probeSucceeds(run: LaunchedProcess): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(run.file, run.args, { env: run.env, timeout: 5_000 }, (error) => resolve(!error))
  })
}
