import type { ForwardedHost, SshAddLink, SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'

/**
 * Adding a machine over SSH that was not discovered on the network, and the
 * forwards that reach such a machine (docs/plans/host-routes.md D6, D7, D9).
 * Pure decisions only: the store does the calls.
 */

export interface SshAddForm {
  sshTarget: string
  /** The person chose to link the new host to their Solus account. */
  linkToAccount: boolean
  password: string
  deviceLabel: string
  requestId: string
}

/**
 * The request for one add. A password goes only with a link: a forward needs key
 * authentication, and the host refuses a password without a link (D6, D7).
 */
export function sshAddRequest(form: SshAddForm, link: SshAddLink | null): SshAddRequest {
  const request: SshAddRequest = {
    sshTarget: form.sshTarget.trim(),
    deviceLabel: form.deviceLabel,
    requestId: form.requestId,
  }
  if (form.linkToAccount && link) {
    request.link = link
    if (form.password) request.authSecret = form.password
  }
  return request
}

export interface SshAddContext {
  linkToAccount: boolean
  /** The SSH ran on this client's own machine, so this client can dial the forward it holds. */
  sshHostIsThisMachine: boolean
  /** The name of the host the SSH ran on. */
  sshHostName: string
}

export type SshAddOutcome =
  /** Save the host with its forwarded route: this client dials it through its own host. */
  | { kind: 'save-forwarded'; message: string }
  /** The forward is on another machine, which lists the host; this client cannot dial it. */
  | { kind: 'forwarded-elsewhere'; message: string }
  /** The host is in the account directory now. */
  | { kind: 'linked'; message: string }
  /** SSH refused the key: the person can give a password, because the host links. */
  | { kind: 'ask-password'; message: string }
  /** SSH refused the key, and a forward cannot use a password. */
  | { kind: 'needs-key'; message: string }
  | { kind: 'failed'; message: string }

/** What one answer of `hostsAddOverSsh` means for a machine that was not discovered. */
export function sshAddOutcome(result: SshAddResult, context: SshAddContext): SshAddOutcome {
  switch (result.status) {
    case 'forwarded':
      return context.sshHostIsThisMachine
        ? { kind: 'save-forwarded', message: `${result.host.label} is added. This computer reaches it over SSH.` }
        : { kind: 'forwarded-elsewhere', message: `${result.host.label} is added. It is reachable only from ${context.sshHostName}, which lists it.` }
    case 'linked':
      return { kind: 'linked', message: `${result.label} is linked to your Solus account.` }
    case 'needs-auth':
      return context.linkToAccount
        ? { kind: 'ask-password', message: `${result.message} Enter the password for ${result.sshTarget}.` }
        : { kind: 'needs-key', message: `${result.message} Without a link to your account, Solus needs an SSH key that ${context.sshHostName} can use for ${result.sshTarget}. Add a key, or link the machine and use a password.` }
    case 'needs-target':
      return { kind: 'failed', message: result.message }
    case 'session':
      // Only a discovered server gives a session, and this flow names none.
      return { kind: 'failed', message: 'The host answered for a discovered server. Add it from the Nearby list.' }
  }
}

export type ForwardedRowTone = 'ok' | 'pending' | 'muted' | 'error'

export interface ForwardedRowStatus {
  text: string
  tone: ForwardedRowTone
}

/**
 * The state of one forward, as one line. A linked host whose forward failed still
 * has its account's tunnel, so that is not an error (D9).
 */
export function forwardedRowStatus(host: Pick<ForwardedHost, 'state' | 'error' | 'isLinked'>): ForwardedRowStatus {
  switch (host.state) {
    case 'open':
      return { text: 'Open', tone: 'ok' }
    case 'reconnecting':
      return { text: 'Reconnecting…', tone: 'pending' }
    case 'failed':
      return host.isLinked
        ? { text: 'SSH route paused — using your account\'s tunnel', tone: 'muted' }
        : { text: host.error || 'The SSH route failed', tone: 'error' }
  }
}

/**
 * Who can dial a forwarded host from here (D7): only a client on the machine that
 * holds the forward, unless the host is linked and reached through the account.
 * Null when this client can reach it.
 */
export function forwardedReachNote(host: Pick<ForwardedHost, 'isLinked'>, viewerHoldsForward: boolean, holderName: string): string | null {
  if (viewerHoldsForward || host.isLinked) return null
  return `Reachable only from ${holderName}`
}
