import { normalizeCheckCode } from '@solus/contracts/add-machine'
import type { AppSignInRequest } from '@solus/contracts/host-api'
import { parseAppSignInLink } from '@solus/contracts/outside-apps'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'
import { APP_ACCESS_OPTIONS } from './outside-app-setup'

/**
 * An outside app's sign-in that the person approves on the phone (plans/035 §0.5,
 * docs/outside-apps.md). It opens in two ways:
 *
 * - **The link.** The sign-in page shows a QR code of `solus://approve-app?host=…&request=…`.
 *   The phone camera opens it in the app. The link names the host by its installation id.
 * - **The check code.** On a host's "Use Solus in other apps" section, the person types
 *   the code that the sign-in page shows.
 *
 * Either way the phone reads the sign-in from the host (`connectionsReadAppSignIn`) and the
 * person approves or denies it (`connectionsDecideAppSignIn`). The app then acts as the
 * person who approved it. One sign-in shows at a time: a newer one replaces it, and a reply
 * for a sign-in that is no longer shown is dropped.
 */

export type AppSignInDecision = 'approve' | 'deny'

export type AppSignInState =
  | { kind: 'closed' }
  /** The link arrived before the phone read its host list. */
  | { kind: 'finding-host' }
  /** No host on this phone has the installation id of the link. */
  | { kind: 'no-host' }
  /** The person types the check code of a sign-in on this host. */
  | { kind: 'entering-code'; hostId: string; error: string | null }
  | { kind: 'loading'; hostId: string }
  /** The host did not give the sign-in: it expired, was answered, or the host refused. */
  | { kind: 'read-failed'; hostId: string; message: string }
  | { kind: 'open'; hostId: string; request: AppSignInRequest; deciding: AppSignInDecision | null; error: string | null }
  | { kind: 'decided'; hostId: string; request: AppSignInRequest; decision: AppSignInDecision }

/** A host this phone knows, with the installation id that the link names. */
export interface AppSignInHost {
  hostId: string
  installationId: string
}

export interface AppSignInsDeps {
  hosts: () => readonly AppSignInHost[]
  /** The host list and the account directory answered (or failed): a host they do not hold is not known. */
  hostsSettled: () => boolean
  /** Fires when the host list changes. */
  onHostsChange: (listener: () => void) => () => void
  connectionFor: (hostId: string) => HostConnection | null
}

type Lookup = { requestId: string } | { checkCode: string }

const CLOSED: AppSignInState = { kind: 'closed' }
const UNREACHABLE = 'This host cannot be reached now.'
const CODE_FORMAT = 'Type the code as it shows on the sign-in page, for example ABCD-2345.'

export class AppSignIns {
  readonly changes = new Listeners()
  private current: AppSignInState = CLOSED
  /** Counts each opened sign-in, so a late reply for an earlier one is dropped. */
  private flow = 0
  private lookup: Lookup | null = null
  private stopWaiting: (() => void) | null = null

  constructor(private readonly deps: AppSignInsDeps) {}

  get state(): AppSignInState {
    return this.current
  }

  /** Opens the sign-in an approve-app link names. False: the link is not one. */
  openLink(link: string): boolean {
    const target = appSignInLinkOf(link)
    if (!target) return false
    const flow = this.start()
    const find = () => {
      if (flow !== this.flow) return
      const hostId = hostForInstallation(this.deps.hosts(), target.hostId)
      if (hostId) {
        this.stopWaitingForHosts()
        void this.read(flow, hostId, { requestId: target.requestId })
      } else if (this.deps.hostsSettled()) {
        this.stopWaitingForHosts()
        this.set({ kind: 'no-host' })
      } else if (!this.stopWaiting) {
        this.set({ kind: 'finding-host' })
        this.stopWaiting = this.deps.onHostsChange(find)
      }
    }
    find()
    return true
  }

  /** Asks for the check code of a sign-in on this host. */
  enterCode(hostId: string): void {
    this.start()
    this.set({ kind: 'entering-code', hostId, error: null })
  }

  /** Reads the sign-in that shows this check code. A code that is not in the format stays to be corrected. */
  submitCode(code: string): void {
    const state = this.current
    if (state.kind !== 'entering-code') return
    const checkCode = normalizeCheckCode(code)
    if (!checkCode) {
      this.set({ ...state, error: CODE_FORMAT })
      return
    }
    void this.read(this.flow, state.hostId, { checkCode })
  }

  /** Reads the sign-in again after a failed read. */
  retry(): void {
    const state = this.current
    if (state.kind !== 'read-failed' || !this.lookup) return
    void this.read(this.flow, state.hostId, this.lookup)
  }

  async decide(decision: AppSignInDecision): Promise<void> {
    const state = this.current
    if (state.kind !== 'open' || state.deciding) return
    const flow = this.flow
    const connection = this.deps.connectionFor(state.hostId)
    if (!connection) {
      this.set({ ...state, error: UNREACHABLE })
      return
    }
    this.set({ ...state, deciding: decision, error: null })
    try {
      await connection.api.connectionsDecideAppSignIn({ requestId: state.request.requestId, decision })
      if (flow === this.flow) this.set({ kind: 'decided', hostId: state.hostId, request: state.request, decision })
    } catch (error) {
      if (flow === this.flow) this.set({ ...state, deciding: null, error: error instanceof Error ? error.message : String(error) })
    }
  }

  close(): void {
    this.start()
    this.set(CLOSED)
  }

  private async read(flow: number, hostId: string, lookup: Lookup): Promise<void> {
    this.lookup = lookup
    const connection = this.deps.connectionFor(hostId)
    if (!connection) {
      this.set({ kind: 'read-failed', hostId, message: UNREACHABLE })
      return
    }
    this.set({ kind: 'loading', hostId })
    try {
      const request = await connection.api.connectionsReadAppSignIn(lookup)
      if (flow === this.flow) this.set({ kind: 'open', hostId, request, deciding: null, error: null })
    } catch (error) {
      if (flow === this.flow) this.set({ kind: 'read-failed', hostId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Ends the sign-in on screen: its late replies are dropped. */
  private start(): number {
    this.stopWaitingForHosts()
    this.lookup = null
    this.flow += 1
    return this.flow
  }

  private stopWaitingForHosts(): void {
    this.stopWaiting?.()
    this.stopWaiting = null
  }

  private set(state: AppSignInState): void {
    this.current = state
    this.changes.notify()
  }
}

/**
 * The host and sign-in of an approve-app link. The sign-in page names the `solus`
 * scheme only; a development or preview build also takes its own scheme, so a
 * developer can open the same link in that build by hand.
 */
export function appSignInLinkOf(link: string): { hostId: string; requestId: string } | null {
  return parseAppSignInLink(link.replace(/^solus-(?:dev|preview):/i, 'solus:'))
}

/** The host on this phone with this installation id. A host that has not told its installation id yet matches by its own id. */
export function hostForInstallation(hosts: readonly AppSignInHost[], installationId: string): string | null {
  return (hosts.find((host) => host.installationId === installationId) ?? hosts.find((host) => host.hostId === installationId))?.hostId ?? null
}

/** "Expires in 4:59", or null once the sign-in expired. */
export function appSignInTimeLeft(expiresAt: number, now: number): string | null {
  const seconds = Math.ceil((expiresAt - now) / 1000)
  if (seconds <= 0) return null
  return `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The lines that tell the person what they approve. */
export function appSignInDetails(request: AppSignInRequest) {
  const option = APP_ACCESS_OPTIONS.find((candidate) => candidate.access === request.access)
  return {
    place: `Access goes to ${request.redirectPlace}`,
    computer: request.onThisComputer ? 'The app is on the computer that opened the sign-in page.' : null,
    access: `${option?.label ?? request.access} access`,
    effect: option?.effect ?? '',
  }
}

export const APP_SIGN_IN_WARNING = 'Only approve a sign-in you just started.'
export const NO_HOST_MESSAGE = 'This sign-in is for a host this phone is not connected to.'

export function appSignInDoneMessage(state: Extract<AppSignInState, { kind: 'decided' }>): string {
  return state.decision === 'approve'
    ? `Approved. Go back to ${state.request.appName}.`
    : `Denied. ${state.request.appName} has no access.`
}
