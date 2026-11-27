import type { HostProvidersAsk } from '@solus/contracts/add-machine'
import type { SeatConnectStartResult } from '@solus/contracts/seats'
import { SETUP_AGENT_LABELS, type SetupAgent } from '@solus/contracts/types'

/** The Sign in card of `add_host` on the phone (docs/host-provider-sign-in.md). */

export function cardTitle(ask: HostProvidersAsk): string {
  return `Sign in to ${SETUP_AGENT_LABELS[ask.provider]} on ${ask.hostName}`
}

/** The id that `ProviderIcon` draws each setup agent's mark by. */
export const PROVIDER_ICON_IDS = { claude: 'claudeAgent', codex: 'codex', agy: 'antigravity' } as const satisfies Record<SetupAgent, string>

/**
 * Where a sign-in on the phone stands. The browser signs in on this phone, the
 * host keeps the account, and the session host closes the card when the host
 * reports it: no step here says "done".
 */
export type SignInPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** The browser is open; `verification` says what the person brings back, if anything. */
  | { kind: 'browser'; verification: SeatConnectStartResult }
  | { kind: 'sending'; verification: SeatConnectStartResult }
  /** The code reached the host; the card closes when the host finishes. */
  | { kind: 'finishing' }

/** What the person pastes after the browser, or null when the host finishes by itself. */
export function pastePrompt(verification: SeatConnectStartResult): string | null {
  if (!verification.requiresCodeInput) return null
  return verification.input === 'redirect-url' ? 'Paste the address of the last page' : 'Paste the code from the sign-in page'
}
