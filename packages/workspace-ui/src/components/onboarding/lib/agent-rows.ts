import type { SeatConnectStartResult } from '@solus/contracts/seats'
import type { SetupAgent } from '@solus/contracts/types'
import type { ProviderRow } from '../../servers/lib/host-onboarding'

/**
 * What the Agents step shows at the end of one provider's row: a quiet status,
 * or the action that moves it on.
 * - `ready`, `synced`: a check in the success tone (`synced`: the account's
 *   login, in the cloud flow).
 * - `waiting`: an amber dot; the browser or a code is awaited.
 * - `busy`: an install or a check runs.
 * - `action`: a button (`row.run`).
 */
export type AgentRowTrailing =
  | { kind: 'ready' | 'synced' | 'waiting' | 'busy'; text: string }
  | { kind: 'action'; text: string }

export interface AgentRowView {
  detail: string
  trailing: AgentRowTrailing
}

export interface AgentRowInput {
  row: ProviderRow
  /** The relayed login waiting on the browser, if any. */
  verification: SeatConnectStartResult | undefined
  machineNoun: string
}

/**
 * One provider's row in the desktop and paired Agents step: the host's own
 * login (decision 7). A host that is not signed in offers its own sign-in.
 */
export function agentRow(input: AgentRowInput): AgentRowView {
  const { row, verification, machineNoun } = input
  if (verification) {
    return {
      detail: verification.requiresCodeInput ? 'Paste the code the sign-in page shows' : 'Finish signing in on the page that opened',
      trailing: { kind: 'waiting', text: verification.requiresCodeInput ? 'Waiting for your code' : 'Finish in your browser' },
    }
  }
  if (row.state === 'busy') return { detail: row.detail, trailing: { kind: 'busy', text: row.detail } }
  if (row.state !== 'done') {
    return { detail: row.detail, trailing: { kind: 'action', text: row.actionLabel ?? 'Sign in' } }
  }
  return { detail: `Signed in on this ${machineNoun}`, trailing: { kind: 'ready', text: 'Ready' } }
}

const LOGIN_COMMANDS = {
  claude: 'claude auth login',
  codex: 'codex login --device-auth',
  agy: 'agy acp --login',
} satisfies Record<SetupAgent, string>

/**
 * The relayed login as the host's terminal shows it, for the terminal panel:
 * the command, the line that says where to go, and the address (and the
 * device code, when the CLI printed one).
 */
export function signInTerminalText(agent: SetupAgent, verification: SeatConnectStartResult): string {
  const lines = [`~ $ ${LOGIN_COMMANDS[agent]}`, 'Opened your browser to sign in…', verification.verificationUrl]
  if (verification.userCode) lines.push(`Enter this code: ${verification.userCode}`)
  return lines.join('\n')
}
