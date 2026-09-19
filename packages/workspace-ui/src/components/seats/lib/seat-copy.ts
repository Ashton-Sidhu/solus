import type { SeatProvider, SeatStatus } from '@solus/contracts/seats'

/** The words a seat row and the connect card share. Pure, so both surfaces say the same thing. */

export function seatLabel(provider: SeatProvider): string {
  return provider === 'claude-code' ? 'Claude' : 'Codex'
}

/**
 * The section's name and the line under it. On the organization's workspace service
 * the logins live in Solus cloud and every runner reads them; on a host they are
 * that host's own seats.
 */
export function seatSectionCopy(isCloudHost: boolean): { label: string; description?: string } {
  return isCloudHost
    ? { label: 'Your logins in Solus cloud', description: 'Runners use these logins for your own turns only.' }
    : { label: 'Your seats' }
}

/** One line under the provider's name: where the seat stands. */
export function seatDescription(status: SeatStatus | undefined, error: string | undefined): string {
  if (error && (!status || status.state === 'none')) return error
  if (!status || status.state === 'none') {
    return status?.hostLogin
      ? 'Not signed in on this host. Sign in to run turns.'
      : 'Not connected. Your turns on this host run on your own login once you connect it.'
  }
  switch (status.state) {
    case 'connecting':
      return 'Waiting on your browser…'
    case 'connected':
      if (status.method === 'token') return 'Connected with a pasted token. The usage meter cannot read this seat.'
      return status.hostLogin
        ? "Signed in on this host. Your turns, automations, and guests you invite run on this login."
        : 'Connected. Your turns here run on your own login.'
    case 'expired':
      return `${status.error ?? 'The provider refused this login.'} Reconnect to continue.`
  }
}

/** What the device prompt asks the person to do, by provider flow. */
export function seatVerificationWhy(provider: SeatProvider, requiresCodeInput: boolean): string {
  const label = seatLabel(provider)
  return requiresCodeInput
    ? `Finish signing in with ${label}, then paste the returned code here.`
    : `Confirm this ${label} code in your browser, then come back.`
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
