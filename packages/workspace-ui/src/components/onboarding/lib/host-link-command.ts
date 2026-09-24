import type { UplinkEnrollmentTicket } from '@solus/contracts/uplink'

/** Every server release attaches the installer, so `latest` always resolves. */
const INSTALL_SCRIPT_URL = 'https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.sh'

/**
 * One command that installs Solus on a computer, starts it, and links it to the
 * account that issued the ticket. The installer skips the install when Solus
 * is already there and still links.
 */
export function hostLinkCommand(ticket: UplinkEnrollmentTicket): string {
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- --link ${shellQuote(ticket.ticket)} --cloud-url ${shellQuote(ticket.directoryUrl)}`
}

function shellQuote(value: string): string {
  return /^[\w.:/@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}
