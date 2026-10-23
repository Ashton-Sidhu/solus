import { SOLUS_PROTOCOL, SOLUS_PROTOCOL_HEADER, uplinkErrorBodySchema, type HostRegistration } from '@solus/contracts/uplink'
import type { SessionRecord, SessionRecordUpsert } from '@solus/contracts/types'
import { createLogger } from '../logger'
import {
  ackDelivery,
  deliveryActorOf,
  deliveryDestinations,
  dropQueuedFor,
  listDelivery,
  onDeliveryQueued,
  queueSessionFacts,
  type DeliveryDestination,
} from './delivery-queue'
import { admissionIdFor, getSessionRecord, isOrganizationWork, onSessionRecordChanged } from '../data/sessions/session-records'
import { isChat } from '@solus/contracts/chat'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../admission/principal'
import type { FetchLike } from '../admission/access-tokens'
import { DelegationError } from './delegations'
import { RUNNER_BATCH_LIMIT, RUNNER_DELIVER_PATH, runnerDeliverResponseSchema, type RunnerDeliverRequest } from './runner-protocol'

const log = createLogger('main', 'runner-delivery')

/**
 * The host's side of delivery to the Solus API (docs/plans/simplify-auth-and-sync.md
 * §4.5; plans/010-standard-oauth.md). Every queued item — a session's record facts, a
 * mirrored row, an organization write the API has no route for — names its
 * organization and the person whose work produced it, decided by the producer and
 * persisted with the row. A delivery pass visits every destination with something
 * queued and sends it on one route, `/runner/deliver`, with that person's delegated
 * token, in sequence order, and acknowledges by sequence for that destination alone.
 *
 * A write does not send by itself: the first write after a quiet moment opens a
 * collect window of about a second, and everything queued in it goes in one request.
 *
 * A person this host does not act for yet is taken on with the access token their
 * client presented here (the token exchange); until they connect, their rows wait. A
 * refusal from the account plane means the person may not work here in that
 * organization: their undelivered rows are dropped, and nobody else's. An account
 * plane or API that cannot be reached is a retry with backoff.
 */

/** What delivery needs from the host's delegations (sync/delegations.ts). */
export interface DeliveryDelegations {
  accessToken(userId: string, scope: { organizationId: string }, resource: { kind: 'api' }): Promise<string>
}

export interface RunnerDeliveryDeps {
  /** The current registration, or null when the host is not registered. */
  registration: () => HostRegistration | null
  delegations: DeliveryDelegations
  /** Who delivers rows no person was named for: the host's owner; null while that is unknown. */
  owner: () => string | null
  fetchImpl?: FetchLike
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  now?: () => number
  /** How long a write waits for others before they go together; `COLLECT_WINDOW_MS` unless a test says otherwise. */
  collectWindowMs?: number
}

export interface RunnerDeliveryStatus {
  /** The last thing that went wrong, until something goes right. */
  error: string | null
}

/** How long the first write after a quiet moment waits for the writes that follow it. */
export const COLLECT_WINDOW_MS = 1_000
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000
/** How often rows of a person this host cannot act for yet are tried again. */
const WAITING_POLL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 15_000

const keyOf = (destination: DeliveryDestination): string => `${destination.organizationId}\u0000${destination.actorUserId}`

/** The outcome of getting a destination's token. */
type TokenOutcome = { kind: 'ok'; token: string } | { kind: 'waiting' } | { kind: 'dropped' } | { kind: 'failed' }

export class RunnerDelivery {
  /** Destinations whose person this host cannot act for right now: why, and when to try again. */
  private readonly waiting = new Map<string, { until: number; reason: string }>()
  private status: RunnerDeliveryStatus = { error: null }
  private running = false
  private wanted = false
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribes: Array<() => void> = []
  private unfollowRecords: (() => void) | null = null
  private stopped = false

  constructor(private readonly deps: RunnerDeliveryDeps) {}

  currentStatus(): RunnerDeliveryStatus {
    return { error: this.status.error }
  }

  /** Subscribes to the queue and starts the first cycle. */
  start(): void {
    this.stopped = false
    this.unsubscribes.push(onDeliveryQueued(() => this.kick()))
    this.followRecords()
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.followRecords()
    this.clearTimer()
  }

  /** The registration changed (made, removed, superseded): every destination is tried again. */
  registrationChanged(): void {
    this.waiting.clear()
    this.attempts = 0
    this.followRecords()
    this.kick()
  }

  /** A person connected, or an organization's standing changed: waiting rows are tried now. */
  retryWaiting(): void {
    this.waiting.clear()
    if (this.stopped) return
    this.wanted = true
    if (this.running) return
    this.schedule(0)
  }

  /**
   * Hear record changes only while there is a registration to report them under. A
   * listener makes every record write read the row back, several times a turn, and an
   * unregistered host would drop the facts anyway.
   */
  private followRecords(): void {
    const wanted = !this.stopped && this.deps.registration() !== null
    if (wanted && !this.unfollowRecords) {
      this.unfollowRecords = onSessionRecordChanged((record) => this.reportSession(record))
    } else if (!wanted && this.unfollowRecords) {
      this.unfollowRecords()
      this.unfollowRecords = null
    }
  }

  /**
   * Runs a cycle once the collect window closes, however many writes arrive in it.
   * A retry after a failure keeps its backoff: every queued write kicks, and a busy
   * turn must not turn a refusal into a request loop.
   */
  kick(): void {
    if (this.stopped) return
    this.wanted = true
    if (this.running || this.timer) return
    this.schedule(this.deps.collectWindowMs ?? COLLECT_WINDOW_MS)
  }

  /**
   * Sends every one of this host's own organization session records once: at boot,
   * so the Solus API holds each record as this host does (simplify-auth-and-sync §5),
   * the turns the boot sweep marked `interrupted` among them. They wait in the queue
   * until the delivery starts.
   */
  async reportStoredSessions(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
      if (record && record.runnerHostId === null) this.reportSession(record)
    }
  }

  /**
   * A change to one of this host's own records: a published record of an
   * organization is queued for that organization, delivered by its owner, and sent
   * when the host is registered. A Local or unpublished record stays this machine's own.
   */
  private reportSession(record: SessionRecord): void {
    const registration = this.deps.registration()
    if (!registration) return
    if (!isOrganizationWork(record)) return
    // A session the API admitted before its provider started names that admission, which is where its owner comes from (organization-vms §3).
    const facts: SessionRecordUpsert = { ...record, runnerHostId: registration.hostId }
    const admissionId = admissionIdFor(record.sessionId)
    if (admissionId) facts.admissionId = admissionId
    // A chat is organization work, but not the organization's to open until its owner shares it (plan 004 D14).
    if (isChat(record.cwd)) facts.privateToOwner = true
    queueSessionFacts({ organizationId: record.organizationId, actorUserId: deliveryActorOf(record.ownerKey) }, facts)
  }

  private schedule(delayMs: number): void {
    this.clearTimer()
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout
    this.timer = setTimeoutFn(() => {
      this.timer = null
      void this.cycle()
    }, delayMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(this.timer)
    this.timer = null
  }

  private async cycle(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    this.wanted = false
    try {
      const outcome = await this.deliverAll()
      if (this.stopped) return
      if (outcome === 'idle') {
        this.attempts = 0
        this.status.error = null
        if (this.wanted) this.schedule(this.deps.collectWindowMs ?? COLLECT_WINDOW_MS)
        else if (this.waiting.size > 0) this.schedule(WAITING_POLL_MS)
      } else if (outcome === 'unregistered') {
        this.attempts = 0
      } else {
        this.attempts += 1
        this.schedule(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.attempts - 1)))
      }
    } finally {
      this.running = false
    }
  }

  /**
   * One pass: for every destination, its person's token, then every queued item.
   * A destination waiting for its person is skipped until its retry time; a
   * destination that fails stops the pass so the backoff applies.
   */
  private async deliverAll(): Promise<'idle' | 'unregistered' | 'failed'> {
    const registration = this.deps.registration()
    if (!registration) return 'unregistered'
    const apiUrl = registration.apiUrl
    if (!apiUrl) {
      this.fail('runner_no_api', new Error('This host was registered before it knew its Solus API. Register it again.'))
      return 'failed'
    }
    const now = this.deps.now?.() ?? Date.now()
    let failed = false
    for (const destination of deliveryDestinations()) {
      if (destination.organizationId === LOCAL_ORGANIZATION_ID) continue
      const waiting = this.waiting.get(keyOf(destination))
      if (waiting && waiting.until > now) continue
      const token = await this.tokenFor(destination)
      if (token.kind === 'waiting' || token.kind === 'dropped') continue
      if (token.kind === 'failed') { failed = true; continue }
      const delivered = await this.deliverDestination(apiUrl, registration.hostId, destination, token.token)
      if (delivered !== 'ok') failed = true
    }
    return failed ? 'failed' : 'idle'
  }

  /**
   * The token a destination's rows travel with. An empty person is the host's owner.
   * A refusal drops what the person's work left queued here: removal ends everything.
   */
  private async tokenFor(destination: DeliveryDestination): Promise<TokenOutcome> {
    const actor = destination.actorUserId || this.deps.owner()
    if (!actor) return this.wait(destination, 'nobody to deliver as yet')
    try {
      const token = await this.deps.delegations.accessToken(actor, { organizationId: destination.organizationId }, { kind: 'api' })
      this.waiting.delete(keyOf(destination))
      return { kind: 'ok', token }
    } catch (error) {
      if (!(error instanceof DelegationError) || error.code === 'ORGANIZATION_API_UNAVAILABLE') {
        this.fail('runner_token_unavailable', error instanceof Error ? error : new Error(String(error)))
        return { kind: 'failed' }
      }
      if (error.code === 'ORGANIZATION_AUTHORITY_MISSING') return this.wait(destination, error.message)
      const dropped = dropQueuedFor(destination)
      log.info('runner_rows_dropped', { organizationId: destination.organizationId, actorUserId: actor, dropped, reason: error.message })
      return { kind: 'dropped' }
    }
  }

  private wait(destination: DeliveryDestination, reason: string): TokenOutcome {
    if (!this.waiting.has(keyOf(destination))) log.info('runner_destination_waiting', { organizationId: destination.organizationId, actorUserId: destination.actorUserId, reason })
    this.waiting.set(keyOf(destination), { until: (this.deps.now?.() ?? Date.now()) + WAITING_POLL_MS, reason })
    return { kind: 'waiting' }
  }

  /**
   * Every queued item of one destination, a batch at a time, until its queue is
   * empty. An item the API refused for good stays named in the queue; one it could
   * not apply yet stops the destination, and the backoff sends it again.
   */
  private async deliverDestination(apiUrl: string, hostId: string, destination: DeliveryDestination, token: string): Promise<'ok' | 'failed'> {
    for (;;) {
      const items = listDelivery(destination, RUNNER_BATCH_LIMIT)
      if (items.length === 0) return 'ok'
      const body: RunnerDeliverRequest = { hostId, items }
      const answered = await this.post(apiUrl, token, destination.organizationId, body)
      if (answered.kind !== 'ok') return 'failed'
      const parsed = runnerDeliverResponseSchema.safeParse(answered.body)
      if (!parsed.success) {
        this.fail('runner_delivery_unreadable', new Error('The Solus API answered with an unreadable delivery receipt'))
        return 'failed'
      }
      const { lastSeq, failed } = parsed.data
      const acked = ackDelivery(destination, lastSeq, failed)
      log.info('runner_delivered', { hostId, organizationId: destination.organizationId, sent: items.length, acked, lastSeq, failed: failed.length })
      // The API stopped before the end of the batch: an item it may apply later.
      if (lastSeq < items[items.length - 1].seq) {
        this.fail('runner_delivery_deferred', new Error(`The Solus API deferred item ${items.find((item) => item.seq > lastSeq)?.seq ?? lastSeq + 1}`))
        return 'failed'
      }
    }
  }

  private async post(apiUrl: string, token: string, organizationId: string, body: RunnerDeliverRequest): Promise<
    | { kind: 'ok'; body: unknown }
    | { kind: 'unauthorized' }
    | { kind: 'refused'; status: number; error: string | null }
    | { kind: 'unreachable'; error: string }
  > {
    let response: Response
    try {
      response = await this.request(`${new URL(apiUrl).origin}${RUNNER_DELIVER_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          [SOLUS_PROTOCOL_HEADER]: String(SOLUS_PROTOCOL),
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.fail('runner_delivery_unreachable', error)
      return { kind: 'unreachable', error: error.message }
    }
    if (response.status === 401) {
      this.fail('runner_delivery_unauthorized', new Error(`${RUNNER_DELIVER_PATH} answered 401 for ${organizationId}`))
      return { kind: 'unauthorized' }
    }
    if (!response.ok) {
      const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
      const error = detail.success ? String(detail.data.error) : null
      this.fail('runner_delivery_refused', new Error(`${RUNNER_DELIVER_PATH} answered ${response.status}${error ? ` ${error}` : ''}`))
      return { kind: 'refused', status: response.status, error }
    }
    return { kind: 'ok', body: await response.json().catch(() => null) }
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  }

  private fail(event: string, error: Error): void {
    this.status.error = error.message
    log.warn(event, { error: error.message, attempts: this.attempts })
  }
}
