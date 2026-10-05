import { uplinkErrorBodySchema, type UplinkLinkConfig } from '@solus/contracts/uplink'
import type { SessionRecord, SessionRecordUpsert } from '@solus/contracts/types'
import type { z } from 'zod'
import { createLogger } from '../logger'
import {
  ackCloudOutboxOpsThrough,
  ackSessionReportsThrough,
  cloudOutboxDestinations,
  dropQueuedFor,
  listCloudOutboxOps,
  listSessionReports,
  markOutboxOpsFailed,
  onOutboxChanged,
  queueSessionReport,
  sessionReportDestinations,
  sessionReportQueued,
  type DeliveryDestination,
} from './outbox/outbox-store'
import { ackMirrorThrough, listMirror, mirrorDestinations, onMirrorChanged } from './mirror/mirror-log'
import { admissionIdFor, onSessionRecordChanged } from '../data/sessions/session-records'
import { isChat } from '@solus/contracts/chat'
import { LOCAL_ORGANIZATION_ID } from '../admission/principal'
import type { FetchLike } from '../admission/access-tokens'
import { DelegationError } from './delegations'
import {
  RUNNER_BATCH_LIMIT,
  RUNNER_MIRROR_PATH,
  RUNNER_OUTBOX_PATH,
  RUNNER_SESSION_RECORDS_PATH,
  runnerMirrorResponseSchema,
  runnerOutboxResponseSchema,
  runnerSessionRecordsResponseSchema,
  type RunnerMirrorRequest,
  type RunnerOutboxRequest,
  type RunnerRequestBody,
  type RunnerSessionRecordsRequest,
} from './runner-protocol'

const log = createLogger('main', 'runner-delivery')

/**
 * The runner's side of delivery to the Solus API (organization-scope §6;
 * plans/010-standard-oauth.md). Every queued item — a cloud-bound outbox op, a
 * session-record report, a mirror log row — names its organization and the person
 * whose work produced it, decided by the producer and persisted with the row. A
 * delivery pass visits every destination with something queued and sends it with that
 * person's delegated access token, to the Solus API the link names, stream by
 * stream in sequence order, and acknowledges by sequence for that destination alone.
 *
 * A person this host does not act for yet is taken on with the access token their
 * client presented here (the token exchange); until they connect, their rows wait. A
 * refusal from the account plane means the person may not work here in that
 * organization: their undelivered rows are dropped, and nobody else's. An account
 * plane or API that cannot be reached is a retry with backoff.
 *
 * Nothing here is on the producer's path: a tool or the indexer writes its row and
 * returns; the delivery wakes up, sends what is queued, and acks.
 */

/** What delivery needs from the host's delegations (sync/delegations.ts). */
export interface DeliveryDelegations {
  ensure(userId: string, organizationId: string): Promise<void>
  accessToken(userId: string, organizationId: string): Promise<string>
  holders(): Array<{ userId: string; organizationId: string }>
}

export interface RunnerDeliveryDeps {
  /** The current link, or null when the host is not linked. */
  link: () => UplinkLinkConfig | null
  delegations: DeliveryDelegations
  /** Who delivers rows no person was named for: the person who linked the host; null while that is unknown. */
  linker: () => string | null
  fetchImpl?: FetchLike
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  now?: () => number
}

export interface RunnerDeliveryStatus {
  /** The last thing that went wrong, until something goes right. */
  error: string | null
}

/** What `call()` answers: the parsed body, or why there is none. */
export type RunnerCallResult<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'refused'; status: number; error: string | null }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; error: string }
  | { kind: 'no-grant' }

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
  private readonly cycleListeners = new Set<() => Promise<void> | void>()

  constructor(private readonly deps: RunnerDeliveryDeps) {}

  currentStatus(): RunnerDeliveryStatus {
    return { error: this.status.error }
  }

  /**
   * Run after every delivery pass that reached the service, and on the idle tick:
   * how the publication coordinator resumes without a timer of its own. A listener
   * that throws is logged and does not stop the others.
   */
  onCycle(listener: () => Promise<void> | void): () => void {
    this.cycleListeners.add(listener)
    return () => { this.cycleListeners.delete(listener) }
  }

  /** Subscribes to the queues and starts the first cycle. */
  start(): void {
    this.stopped = false
    this.unsubscribes.push(onOutboxChanged(() => this.kick()))
    this.unsubscribes.push(onMirrorChanged(() => this.kick()))
    this.followRecords()
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.followRecords()
    this.clearTimer()
  }

  /** The link changed (made, removed, superseded): every destination is tried again. */
  linkChanged(): void {
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

  /** Why a destination's rows are not moving: its person must connect first. Null while they can go. */
  waitingReason(destination: DeliveryDestination): string | null {
    return this.waiting.get(keyOf(destination))?.reason ?? null
  }

  /**
   * Hear record changes only while there is a link to report them to. A listener
   * makes every record write read the row back, several times a turn, and an
   * unlinked host would drop the report anyway.
   */
  private followRecords(): void {
    const wanted = !this.stopped && this.deps.link() !== null
    if (wanted && !this.unfollowRecords) {
      this.unfollowRecords = onSessionRecordChanged((record) => this.reportSession(record))
    } else if (!wanted && this.unfollowRecords) {
      this.unfollowRecords()
      this.unfollowRecords = null
    }
  }

  /**
   * Runs a cycle soon, once, however many times it is asked while one runs. A
   * retry after a failure keeps its backoff: every queued write kicks, and a busy
   * turn must not turn a refusal into a request loop.
   */
  kick(): void {
    if (this.stopped) return
    this.wanted = true
    if (this.running) return
    if (this.attempts > 0 && this.timer) return
    this.clearTimer()
    this.schedule(0)
  }

  /**
   * One authenticated request to the Solus API as one person in one organization.
   * Nothing here retries on its own; the caller tries again later.
   */
  async call<T>(destination: DeliveryDestination, path: string, body: RunnerRequestBody, schema: z.ZodType<T>): Promise<RunnerCallResult<T>> {
    const link = this.deps.link()
    if (!link?.apiUrl) return { kind: 'no-grant' }
    const token = await this.tokenFor(destination)
    if (token.kind !== 'ok') return { kind: 'no-grant' }
    const answered = await this.post(link.apiUrl, token.token, destination.organizationId, path, body)
    if (answered.kind !== 'ok') return answered
    const parsed = schema.safeParse(answered.body)
    if (!parsed.success) return { kind: 'refused', status: 200, error: `unreadable answer from ${path}` }
    return { kind: 'ok', body: parsed.data }
  }

  /** One destination per organization this host acts for someone in: where the shared-prompt poller asks. */
  pollTargets(): DeliveryDestination[] {
    const byOrganization = new Map<string, DeliveryDestination>()
    for (const holder of this.deps.delegations.holders()) {
      if (!byOrganization.has(holder.organizationId)) byOrganization.set(holder.organizationId, { organizationId: holder.organizationId, actorUserId: holder.userId })
    }
    return [...byOrganization.values()]
  }

  /**
   * A change to one of this host's own records: a published record of an
   * organization is queued for that organization, delivered by its owner, and sent
   * when the host is linked. A Local or unpublished record stays this machine's own.
   */
  private reportSession(record: SessionRecord): void {
    const link = this.deps.link()
    if (!link) return
    if (record.organizationId === LOCAL_ORGANIZATION_ID || record.publication !== 'published') return
    // A session the API admitted before its provider started names that admission, which is where its owner comes from (organization-vms §3).
    const report: SessionRecordUpsert = { ...record, runnerHostId: link.hostId }
    const admissionId = admissionIdFor(record.sessionId)
    if (admissionId) report.admissionId = admissionId
    // A chat is organization work, but not the organization's to open until its owner shares it (plan 004 D14).
    if (isChat(record.cwd)) report.privateToOwner = true
    queueSessionReport({ organizationId: record.organizationId, actorUserId: record.ownerUserId ?? '' }, report)
    this.kick()
  }

  /**
   * Waits, briefly, until a record's report has reached its organization's API: an
   * agent's first write that names its session needs the session there. False when
   * it has not arrived in time; the write then answers what the API says.
   */
  async deliverSessionReport(recordId: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = (this.deps.now?.() ?? Date.now()) + timeoutMs
    while (sessionReportQueued(recordId)) {
      if ((this.deps.now?.() ?? Date.now()) >= deadline || this.stopped) return false
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 1_000)
        const stopListening = this.onCycle(done)
        function done(): void { clearTimeout(timer); stopListening(); resolve() }
        this.kick()
      })
    }
    return true
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
        await this.runCycleListeners()
        if (this.wanted) this.schedule(0)
        else if (this.waiting.size > 0) this.schedule(WAITING_POLL_MS)
      } else if (outcome === 'unlinked') {
        this.attempts = 0
      } else {
        this.attempts += 1
        this.schedule(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.attempts - 1)))
      }
    } finally {
      this.running = false
    }
  }

  private async runCycleListeners(): Promise<void> {
    for (const listener of this.cycleListeners) {
      try {
        await listener()
      } catch (error) {
        log.warn('runner_cycle_listener_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** Every destination with something queued in any stream. */
  private destinations(): DeliveryDestination[] {
    const byKey = new Map<string, DeliveryDestination>()
    for (const destination of [...cloudOutboxDestinations(), ...sessionReportDestinations(), ...mirrorDestinations()]) {
      if (destination.organizationId === LOCAL_ORGANIZATION_ID) continue
      byKey.set(keyOf(destination), destination)
    }
    return [...byKey.values()]
  }

  /**
   * One pass: for every destination, its person's token, then every queued item of
   * every stream. A destination waiting for its person is skipped until its retry
   * time; a destination that fails stops the pass so the backoff applies.
   */
  private async deliverAll(): Promise<'idle' | 'unlinked' | 'failed'> {
    const link = this.deps.link()
    if (!link) return 'unlinked'
    const apiUrl = link.apiUrl
    if (!apiUrl) {
      this.fail('runner_no_api', new Error('This host was linked before it knew its Solus API. Link it again.'))
      return 'failed'
    }
    const now = this.deps.now?.() ?? Date.now()
    let failed = false
    for (const destination of this.destinations()) {
      const waiting = this.waiting.get(keyOf(destination))
      if (waiting && waiting.until > now) continue
      const token = await this.tokenFor(destination)
      if (token.kind === 'waiting' || token.kind === 'dropped') continue
      if (token.kind === 'failed') { failed = true; continue }
      const delivered = await this.deliverDestination(apiUrl, link.hostId, destination, token.token)
      if (delivered !== 'ok') failed = true
    }
    return failed ? 'failed' : 'idle'
  }

  /**
   * The token a destination's rows travel with. An empty person is the host's linker.
   * A refusal drops what the person's work left queued here: removal ends everything.
   */
  private async tokenFor(destination: DeliveryDestination): Promise<TokenOutcome> {
    const actor = destination.actorUserId || this.deps.linker()
    if (!actor) return this.wait(destination, 'nobody to deliver as yet')
    try {
      await this.deps.delegations.ensure(actor, destination.organizationId)
      const token = await this.deps.delegations.accessToken(actor, destination.organizationId)
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

  /** Every queued item of one destination, stream by stream, until its queues are empty. */
  private async deliverDestination(apiUrl: string, hostId: string, destination: DeliveryDestination, token: string): Promise<'ok' | 'failed'> {
    for (;;) {
      const ops = listCloudOutboxOps(destination, RUNNER_BATCH_LIMIT)
      const reports = listSessionReports(destination, RUNNER_BATCH_LIMIT)
      const mirrored = listMirror(destination, RUNNER_BATCH_LIMIT)
      if (ops.length === 0 && reports.length === 0 && mirrored.length === 0) return 'ok'
      if (ops.length > 0 && await this.deliverOutbox(apiUrl, token, hostId, destination, ops) !== 'ok') return 'failed'
      if (reports.length > 0 && await this.deliverSessionReports(apiUrl, token, hostId, destination, reports) !== 'ok') return 'failed'
      if (mirrored.length > 0 && await this.deliverMirror(apiUrl, token, hostId, destination, mirrored) !== 'ok') return 'failed'
    }
  }

  private async deliverOutbox(apiUrl: string, token: string, hostId: string, destination: DeliveryDestination, ops: ReturnType<typeof listCloudOutboxOps>): Promise<'ok' | 'failed'> {
    const body: RunnerOutboxRequest = { hostId, ops }
    const answered = await this.post(apiUrl, token, destination.organizationId, RUNNER_OUTBOX_PATH, body)
    if (answered.kind !== 'ok') return 'failed'
    const parsed = runnerOutboxResponseSchema.safeParse(answered.body)
    if (!parsed.success) {
      this.fail('runner_outbox_unreadable', new Error('The Solus API answered with an unreadable outbox receipt'))
      return 'failed'
    }
    const permanent = parsed.data.failed.filter((failure) => failure.permanent)
    if (permanent.length > 0) {
      const byseq = new Map(ops.map((entry) => [entry.seq, entry.op.id]))
      markOutboxOpsFailed(permanent.flatMap((failure) => {
        const id = byseq.get(failure.seq)
        return id ? [{ id, error: failure.error }] : []
      }))
    }
    const acked = ackCloudOutboxOpsThrough(destination, parsed.data.lastSeq)
    log.info('runner_outbox_delivered', { hostId, organizationId: destination.organizationId, sent: ops.length, acked, lastSeq: parsed.data.lastSeq, failed: parsed.data.failed.length })
    const transient = parsed.data.failed.find((failure) => !failure.permanent)
    if (transient) {
      this.fail('runner_outbox_op_deferred', new Error(transient.error))
      return 'failed'
    }
    return 'ok'
  }

  private async deliverSessionReports(apiUrl: string, token: string, hostId: string, destination: DeliveryDestination, reports: ReturnType<typeof listSessionReports>): Promise<'ok' | 'failed'> {
    const body: RunnerSessionRecordsRequest = { hostId, reports }
    const answered = await this.post(apiUrl, token, destination.organizationId, RUNNER_SESSION_RECORDS_PATH, body)
    if (answered.kind !== 'ok') return 'failed'
    const parsed = runnerSessionRecordsResponseSchema.safeParse(answered.body)
    if (!parsed.success) {
      this.fail('runner_session_records_unreadable', new Error('The Solus API answered with an unreadable session-record receipt'))
      return 'failed'
    }
    const acked = ackSessionReportsThrough(destination, parsed.data.lastSeq)
    log.info('runner_session_records_delivered', { hostId, organizationId: destination.organizationId, sent: reports.length, acked, lastSeq: parsed.data.lastSeq })
    return 'ok'
  }

  private async deliverMirror(apiUrl: string, token: string, hostId: string, destination: DeliveryDestination, items: ReturnType<typeof listMirror>): Promise<'ok' | 'failed'> {
    const body: RunnerMirrorRequest = { hostId, items }
    const answered = await this.post(apiUrl, token, destination.organizationId, RUNNER_MIRROR_PATH, body)
    if (answered.kind !== 'ok') return 'failed'
    const parsed = runnerMirrorResponseSchema.safeParse(answered.body)
    if (!parsed.success) {
      this.fail('runner_mirror_unreadable', new Error('The Solus API answered with an unreadable mirror receipt'))
      return 'failed'
    }
    const acked = ackMirrorThrough(destination, parsed.data.lastSeq)
    log.info('runner_mirror_delivered', { hostId, organizationId: destination.organizationId, sent: items.length, acked, lastSeq: parsed.data.lastSeq })
    return 'ok'
  }

  private async post(apiUrl: string, token: string, organizationId: string, path: string, body: RunnerRequestBody): Promise<
    | { kind: 'ok'; body: unknown }
    | { kind: 'unauthorized' }
    | { kind: 'refused'; status: number; error: string | null }
    | { kind: 'unreachable'; error: string }
  > {
    let response: Response
    try {
      response = await this.request(`${new URL(apiUrl).origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.fail('runner_delivery_unreachable', error)
      return { kind: 'unreachable', error: error.message }
    }
    if (response.status === 401) {
      this.fail('runner_delivery_unauthorized', new Error(`${path} answered 401 for ${organizationId}`))
      return { kind: 'unauthorized' }
    }
    if (!response.ok) {
      const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
      const error = detail.success ? String(detail.data.error) : null
      this.fail('runner_delivery_refused', new Error(`${path} answered ${response.status}${error ? ` ${error}` : ''}`))
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
