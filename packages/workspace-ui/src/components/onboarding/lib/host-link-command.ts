import { formatLinkCode, type UplinkEnrollmentTicket } from '@solus/contracts/uplink'
import { INSTALL_SCRIPT_URLS } from '@solus/contracts/remote-machines'

/**
 * One command that installs Solus on a computer, starts it, and links it to the
 * account that issued the ticket. The link code names that account plane itself
 * (plans/009-organization-vms.md §5). The installer skips the install when Solus
 * is already there and still links.
 */
export function hostLinkCommand(ticket: UplinkEnrollmentTicket): string {
  return `curl -fsSL ${INSTALL_SCRIPT_URLS.unix} | sh -s -- --link ${shellQuote(formatLinkCode(ticket.ticket, ticket.directoryUrl))}`
}

/** The same for Windows PowerShell: the installer script takes the link code as `-Link`, as the SSH add runs it. */
export function windowsHostLinkCommand(ticket: UplinkEnrollmentTicket): string {
  const code = formatLinkCode(ticket.ticket, ticket.directoryUrl).replaceAll("'", "''")
  return `& ([scriptblock]::Create((irm '${INSTALL_SCRIPT_URLS.windows}'))) -Link '${code}'`
}

function shellQuote(value: string): string {
  return /^[\w.:/@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}
