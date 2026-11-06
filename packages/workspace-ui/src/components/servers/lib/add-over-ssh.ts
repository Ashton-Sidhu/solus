import type { ForwardedHost, SshAddLink, SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'
import type { PairingPhase } from './pairing-bridge'

/**
 * Adding a machine over SSH that was not discovered on the network, and the
 * forwards that reach such a machine (docs/plans/host-routes.md D6, D7, D9).
 * Pure decisions only: the store does the calls.
 */

export interface SshAddForm {
  sshTarget: string
  /** A private key on the SSH host (`ssh -i`), or empty for SSH's own keys and config. */
  identityFile: string
  /** The person chose to link the new host to their Solus account. */
  linkToAccount: boolean
  password: string
  deviceLabel: string
  requestId: string
}

/** The request for one add. The password goes with a link and with a forward, which keeps it in the host's memory. */
export function sshAddRequest(form: SshAddForm, link: SshAddLink | null): SshAddRequest {
  const request: SshAddRequest = {
    sshTarget: form.sshTarget.trim(),
    deviceLabel: form.deviceLabel,
    requestId: form.requestId,
  }
  const identityFile = form.identityFile.trim()
  if (identityFile) request.identityFile = identityFile
  if (form.linkToAccount && link) request.link = link
  if (form.password) request.authSecret = form.password
  return request
}

export interface SshAddContext {
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
  /** SSH refused the key or the secret: the person can give a password. */
  | { kind: 'ask-password'; message: string }
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
      return { kind: 'ask-password', message: `${result.message} Enter the password for ${result.sshTarget}.` }
    case 'needs-target':
      return { kind: 'failed', message: result.message }
    case 'session':
      // Only a discovered server gives a session, and this flow names none.
      return { kind: 'failed', message: 'The host answered for a discovered server. Add it from the Nearby list.' }
  }
}

/**
 * Where the pairing bridge stands for an SSH add, so the SSH tab draws the same
 * bridge as pairing: the target stands in for the host until the add ends.
 */
export function sshBridgePhase(state: { phase: 'form' | 'running' | 'done'; sshTarget: string; error: string }): PairingPhase {
  if (state.phase === 'running') return 'pairing'
  if (state.phase === 'done') return 'paired'
  if (state.error) return 'error'
  return state.sshTarget.trim() ? 'found' : 'empty'
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
    case 'needs-auth':
      if (host.error) return { text: host.error, tone: 'error' }
      return host.isLinked
        ? { text: 'SSH route paused — enter the password to use it', tone: 'muted' }
        : { text: 'Password needed to reconnect', tone: 'pending' }
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
 * The forwards that began to wait for a password since `waiting` was read. A linked
 * host has its tunnel meanwhile, so it does not interrupt the person (D9).
 */
export function forwardsNewlyWaiting(forwarded: readonly ForwardedHost[], waiting: ReadonlySet<string>): ForwardedHost[] {
  return forwarded.filter((host) => host.state === 'needs-auth' && !host.isLinked && !waiting.has(host.installationId))
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
