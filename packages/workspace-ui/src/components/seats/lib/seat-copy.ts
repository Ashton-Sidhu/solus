import type { SeatProvider, SeatStatus } from '@solus/contracts/seats'

/** The words a seat row and the connect card share. Pure, so both surfaces say the same thing. */

export function seatLabel(provider: SeatProvider): string {
  return provider === 'claude-code' ? 'Claude' : 'Codex'
}

/** One line under the provider's name: where the seat stands. */
export function seatDescription(status: SeatStatus | undefined, error: string | undefined): string {
  if (error && (!status || status.state === 'none')) return error
  if (!status || status.state === 'none') {
    return status?.hostLogin
      ? 'Not signed in yet. Sign in so Solus can work on this computer.'
      : 'Not connected yet. Connect your own account so Solus can work for you here.'
  }
  switch (status.state) {
    case 'connecting':
      return 'Finish signing in below.'
    case 'connected':
      if (status.method === 'token') return 'Connected with a pasted token. The usage meter cannot read this seat.'
      return status.hostLogin
        ? "Signed in on this host. Your turns, automations, and guests you invite run on this login."
        : 'Connected. Your turns here run on your own login.'
    case 'expired':
      return `${status.error ?? 'The provider refused this login.'} Reconnect to continue.`
  }
}

/** The pasted-credential fallback, named by what the person has to paste. */
export function seatTokenHint(provider: SeatProvider): string {
  return provider === 'claude-code'
    ? 'Run `claude setup-token` on your own machine and paste the token. It runs turns but cannot show usage.'
    : 'Paste the contents of your ~/.codex/auth.json from a machine where you are signed in.'
}

/**
 * The verb on the row's control, by state. The host login signed in through the
 * CLI is never disconnected from Solus; a different account is a new sign-in over it.
 */
export function seatAction(status: SeatStatus | undefined): 'connect' | 'reconnect' | 'disconnect' | 'switch' | 'cancel' {
  switch (status?.state) {
    case 'connected':
      return status.hostLogin && status.method === 'login' ? 'switch' : 'disconnect'
    case 'connecting':
      return 'cancel'
    case 'expired':
      return 'reconnect'
    default:
      return 'connect'
  }
}
