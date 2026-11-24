import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import {
  PAIR_APPROVAL_MAX_OPEN,
  PAIR_APPROVAL_TTL_MS,
  PAIR_APPROVAL_WAIT_MS,
  type PairApprovalDecision,
  type PairApprovalRequest,
} from '@solus/contracts/add-machine'
import { createLogger } from '../logger'
import { issueSessionToken, revokeSessionToken } from './auth'

const log = createLogger('main', 'pair-approvals')

/** How long a decided or expired request stays, so the requester's next wait still reads the result. */
const SETTLED_KEEP_MS = 2 * PAIR_APPROVAL_WAIT_MS

/** What a wait gives back. The HTTP route adds the host's identity to `approved`. */
export type PairApprovalOutcome =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; sessionToken: string }

type RequestState =
  | { kind: 'pending' }
  | { kind: 'denied'; keepUntil: number }
  | { kind: 'expired'; keepUntil: number }
  /** The token waits here until the requester collects it; it is revoked when nobody does. */
  | { kind: 'approved'; keepUntil: number; sessionToken: string }

interface ApprovalEntry {
  view: PairApprovalRequest
  waitTokenHash: Buffer
  replacesSessionToken?: string
  state: RequestState
  /** Wakes the long polls of this request when its state changes. */
  wake: Set<() => void>
}

export interface PairApprovalsOptions {
  now?: () => number
  /** The longest one wait holds; tests make it short. */
  waitMs?: number
}

/**
 * The open approval requests of this host (docs/plans/add-machine-card.md, "The
 * approval request"). A machine asks to pair without a code; an owner approves
 * or denies it. The requests live in memory only: a restart forgets them, and the
 * requester then reads `expired`.
 *
 * Approval issues a session token as `POST /pair` does, so the device is listed
 * and revocable with the other paired devices. Only the requester, who holds the
 * `waitToken`, can collect that token.
 */
export class PairApprovals {
  private readonly entries = new Map<string, ApprovalEntry>()
  private readonly listeners = new Set<(approvals: PairApprovalRequest[]) => void>()
  private readonly now: () => number
  private readonly waitMs: number

  constructor(options: PairApprovalsOptions = {}) {
    this.now = options.now ?? Date.now
    this.waitMs = options.waitMs ?? PAIR_APPROVAL_WAIT_MS
  }

  /**
   * A new request, or null when `PAIR_APPROVAL_MAX_OPEN` requests are already open.
   * The requester made `checkCode` (normalized by `normalizeCheckCode`) and shows it,
   * so the owner can compare it with the code on the requester's screen.
   */
  start(input: { deviceLabel: string; checkCode: string; fromAddress: string; replacesSessionToken?: string }): { request: PairApprovalRequest; waitToken: string } | null {
    if (this.list().length >= PAIR_APPROVAL_MAX_OPEN) return null
    const now = this.now()
    const waitToken = randomBytes(32).toString('base64url')
    const view: PairApprovalRequest = {
      requestId: randomBytes(12).toString('hex'),
      checkCode: input.checkCode,
      deviceLabel: input.deviceLabel,
      fromAddress: input.fromAddress,
      requestedAt: now,
      expiresAt: now + PAIR_APPROVAL_TTL_MS,
    }
    this.entries.set(view.requestId, {
      view,
      waitTokenHash: hashOf(waitToken),
      replacesSessionToken: input.replacesSessionToken,
      state: { kind: 'pending' },
      wake: new Set(),
    })
    this.sweepAt(view.expiresAt)
    log.info('pair_approval_requested', { requestId: view.requestId, deviceLabel: view.deviceLabel, fromAddress: view.fromAddress })
    this.notify()
    return { request: { ...view }, waitToken }
  }

  /** The open requests, the oldest first. */
  list(): PairApprovalRequest[] {
    this.sweep()
    return this.openViews()
  }

  /** Approves or denies an open request. False when it is no longer open. */
  decide(requestId: string, decision: PairApprovalDecision): boolean {
    this.sweep()
    const entry = this.entries.get(requestId)
    if (!entry || entry.state.kind !== 'pending') return false
    const keepUntil = this.now() + SETTLED_KEEP_MS
    if (decision === 'approve') {
      const { token: sessionToken } = issueSessionToken(entry.view.deviceLabel, this.now())
      const replaced = entry.replacesSessionToken ? revokeSessionToken(entry.replacesSessionToken) : false
      entry.state = { kind: 'approved', keepUntil, sessionToken }
      log.info('pair_session_issued', { deviceLabel: entry.view.deviceLabel, approval: true, replaced })
    } else {
      entry.state = { kind: 'denied', keepUntil }
    }
    log.info('pair_approval_decided', { requestId, decision })
    this.sweepAt(keepUntil)
    this.settled(entry)
    return true
  }

  /**
   * The requester's long poll: the result once there is one, else `pending` after
   * at most `waitMs`. An unknown request and a wrong `waitToken` both read
   * `expired` at once, so a caller without the token learns nothing.
   */
  async wait(requestId: string, waitToken: string, signal?: AbortSignal): Promise<PairApprovalOutcome> {
    this.sweep()
    const entry = this.entries.get(requestId)
    if (!entry || !timingSafeEqual(entry.waitTokenHash, hashOf(waitToken))) return { status: 'expired' }
    if (entry.state.kind === 'pending') await this.changeOf(entry, signal)
    this.sweep()
    const state = entry.state
    if (state.kind === 'pending') return { status: 'pending' }
    // A result is read once; a second read finds no request.
    if (this.entries.get(requestId) === entry) this.entries.delete(requestId)
    if (state.kind === 'approved') return { status: 'approved', sessionToken: state.sessionToken }
    return { status: state.kind === 'denied' ? 'denied' : 'expired' }
  }

  /** Calls `listener` with the whole open list after each change. */
  subscribe(listener: (approvals: PairApprovalRequest[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Expires what is due: an open request at its `expiresAt`, a result after `SETTLED_KEEP_MS`. */
  sweep(): void {
    const now = this.now()
    let openChanged = false
    for (const [requestId, entry] of this.entries) {
      const state = entry.state
      if (state.kind === 'pending') {
        if (now < entry.view.expiresAt) continue
        entry.state = { kind: 'expired', keepUntil: now + SETTLED_KEEP_MS }
        log.info('pair_approval_expired', { requestId })
        openChanged = true
        this.sweepAt(entry.state.keepUntil)
        for (const wake of entry.wake) wake()
        continue
      }
      if (now < state.keepUntil) continue
      this.entries.delete(requestId)
      // Nobody collected the token: the device never got it, so it must not stay valid.
      if (state.kind === 'approved') {
        revokeSessionToken(state.sessionToken)
        log.info('pair_approval_uncollected', { requestId })
      }
    }
    if (openChanged) this.notify()
  }

  private settled(entry: ApprovalEntry): void {
    for (const wake of entry.wake) wake()
    this.notify()
  }

  private notify(): void {
    if (!this.listeners.size) return
    const approvals = this.openViews()
    for (const listener of this.listeners) listener(approvals)
  }

  private openViews(): PairApprovalRequest[] {
    return [...this.entries.values()].filter((entry) => entry.state.kind === 'pending').map((entry) => ({ ...entry.view }))
  }

  /** Resolves when the entry changes, after `waitMs`, at its expiry, or when the caller leaves. */
  private changeOf(entry: ApprovalEntry, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        entry.wake.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, Math.min(this.waitMs, entry.view.expiresAt - this.now())))
      entry.wake.add(done)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
  }

  private sweepAt(at: number): void {
    setTimeout(() => this.sweep(), Math.max(0, at - this.now()) + 10).unref?.()
  }
}

function hashOf(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}
