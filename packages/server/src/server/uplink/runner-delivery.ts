import { runnerGrantResponseSchema, uplinkErrorBodySchema, type UplinkLinkConfig } from '@solus/contracts/uplink'
import type { SessionRecord } from '@solus/contracts/types'
import { createLogger } from '../../logger'
import {
  ackCloudOutboxOpsThrough,
  ackSessionReportsThrough,
  listCloudOutboxOps,
  listSessionReports,
  markOutboxOpsFailed,
  onOutboxChanged,
  queueSessionReport,
} from '../../outbox/outbox-store'
import { setCloudOwnedOrganization } from '../../outbox/cloud-ownership'
import { onSessionRecordChanged } from '../../sessions/session-records'
import type { FetchLike } from '../host-grants'
import {
  RUNNER_BATCH_LIMIT,
  RUNNER_OUTBOX_PATH,
  RUNNER_SESSION_RECORDS_PATH,
  runnerOutboxResponseSchema,
  runnerSessionRecordsResponseSchema,
  type RunnerOutboxRequest,
  type RunnerSessionRecordsRequest,
} from './runner-protocol'

const log = createLogger('main', 'runner-delivery')

/**
 * The runner's side of delivery to its organization's workspace service
 * (docs/plans/cloud-service-model.md §16). A linked host that is shared with an
 * organization exchanges its host token for a runner grant, learns the
 * organization and the way to the service, and from then on ships two streams
 * in sequence order: cloud-bound outbox ops and session-record reports.
 *
 * Nothing here is on the producer's path: a tool or the indexer writes its row
 * and returns; the delivery wakes up, sends what is queued, and acks by
 * sequence. A failure backs off and tries again; a restart resumes from what is
 * still queued; a 401 mints a fresh grant. A host the control plane does not
 * count in any organization keeps asking, slowly, so attaching it later needs
 * no restart.
 */

export interface RunnerDeliveryDeps {
  /** The current link, or null when the host is not linked. */
  link: () => UplinkLinkConfig | null
  /** The host token from the secret store, or null when the credentials are gone. */
  hostToken: () => string | null
  fetchImpl?: FetchLike
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  now?: () => number
}

export interface RunnerDeliveryStatus {
  organizationId: string | null
  workspaceUrl: string | null
  /** The last thing that went wrong, until something goes right. */
  error: string | null
}

interface RunnerGrant {
  grant: string
  organizationId: string
  workspaceUrl: string
  expiresAt: number
}

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000
/** How often a linked host that is in no organization asks again. */
const REATTACH_POLL_MS = 5 * 60_000
/** A grant this close to expiry is replaced before it is used. */
const GRANT_RENEWAL_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

export class RunnerDelivery {
  private grant: RunnerGrant | null = null
  private status: RunnerDeliveryStatus = { organizationId: null, workspaceUrl: null, error: null }
  private running = false
  private wanted = false
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribes: Array<() => void> = []
  private stopped = false

  constructor(private readonly deps: RunnerDeliveryDeps) {}

  currentStatus(): RunnerDeliveryStatus {
    return { ...this.status }
  }

  /** Subscribes to the queues and starts the first cycle. */
  start(): void {
    this.stopped = false
    this.unsubscribes.push(onOutboxChanged(() => this.kick()))
    this.unsubscribes.push(onSessionRecordChanged((record) => this.reportSession(record)))
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.clearTimer()
    this.setOrganization(null)
  }

  /** The link changed (made, removed, superseded): forget the grant and start over. */
  linkChanged(): void {
    this.grant = null
    this.attempts = 0
    this.setOrganization(null)
    this.kick()
  }

  /** A change to one of this host's own records: queue it, and send it when the host is linked. */
  private reportSession(record: SessionRecord): void {
    const link = this.deps.link()
    if (!link) return
    queueSessionReport({ ...record, runnerHostId: link.hostId })
    this.kick()
  }

  /** Runs a cycle soon, once, however many times it is asked while one runs. */
  private kick(): void {
    if (this.stopped) return
    this.wanted = true
    if (this.running) return
    this.clearTimer()
    this.schedule(0)
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
        if (this.wanted) this.schedule(0)
      } else if (outcome === 'unshared') {
        this.attempts = 0
        this.schedule(REATTACH_POLL_MS)
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

  /** One pass: a grant, then every queued item of both streams. */
  private async deliverAll(): Promise<'idle' | 'unlinked' | 'unshared' | 'failed'> {
    const link = this.deps.link()
    const hostToken = link ? this.deps.hostToken() : null
    if (!link || !hostToken) {
      this.grant = null
      this.setOrganization(null)
      return 'unlinked'
    }
    const minted = await this.ensureGrant(link, hostToken)
    if (minted !== 'ok') return minted
    for (;;) {
      const grant = this.grant
      if (!grant) return 'failed'
      const ops = listCloudOutboxOps(RUNNER_BATCH_LIMIT)
      const reports = listSessionReports(RUNNER_BATCH_LIMIT)
      if (ops.length === 0 && reports.length === 0) return 'idle'
      if (ops.length > 0) {
        const outcome = await this.deliverOutbox(grant, link.hostId, ops)
        if (outcome !== 'ok') return outcome === 'unauthorized' ? this.retryAfterUnauthorized() : 'failed'
      }
      if (reports.length > 0) {
        const outcome = await this.deliverSessionReports(grant, link.hostId, reports)
        if (outcome !== 'ok') return outcome === 'unauthorized' ? this.retryAfterUnauthorized() : 'failed'
      }
    }
  }

  /** The service refused the grant: it is minted again on the next cycle, right away. */
  private retryAfterUnauthorized(): 'failed' {
    this.grant = null
    return 'failed'
  }

  private async ensureGrant(link: UplinkLinkConfig, hostToken: string): Promise<'ok' | 'unshared' | 'failed'> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.grant && this.grant.expiresAt - now > GRANT_RENEWAL_MARGIN_MS) return 'ok'
    let response: Response
    try {
      response = await this.request(`${link.directoryUrl}/v1/hosts/${link.hostId}/runner-grant`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hostToken}`, accept: 'application/json' },
      })
    } catch (err) {
      this.fail('runner_grant_unreachable', err instanceof Error ? err : new Error(String(err)))
      return 'failed'
    }
    if (!response.ok) {
      const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
      return this.refuseGrant(link, response.status, detail.success ? detail.data.error : undefined)
    }
    const parsed = runnerGrantResponseSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      this.fail('runner_grant_unreadable', new Error('The runner grant answer was not one'))
      return 'failed'
    }
    const route = parsed.data.routes.find((candidate) => candidate.kind === 'tunnel') ?? parsed.data.routes[0]
    if (!route) {
      this.fail('runner_grant_no_route', new Error('The runner grant named no way to the workspace'))
      return 'failed'
    }
    this.grant = {
      grant: parsed.data.grant,
      organizationId: parsed.data.organizationId,
      workspaceUrl: new URL(route.url).origin,
      expiresAt: parsed.data.expiresAt,
    }
    this.status.error = null
    if (this.status.organizationId !== this.grant.organizationId || this.status.workspaceUrl !== this.grant.workspaceUrl) {
      log.info('runner_grant_minted', { hostId: link.hostId, organizationId: this.grant.organizationId, workspaceUrl: this.grant.workspaceUrl })
    }
    this.status.workspaceUrl = this.grant.workspaceUrl
    this.setOrganization(this.grant.organizationId)
    return 'ok'
  }

  /** The control plane would not mint: either the host is in no organization, which is a state, or something is wrong, which is a retry. */
  private refuseGrant(link: UplinkLinkConfig, status: number, code: string | undefined): 'unshared' | 'failed' {
    const unshared = status === 404 || status === 403 || code === 'host_not_in_organization' || code === 'workspace_not_configured'
    if (!unshared) {
      this.fail('runner_grant_refused', new Error(`${status}${code ? ` ${code}` : ''}`))
      return 'failed'
    }
    // Not shared with an organization (or the cloud has no workspace yet): the host's writes stay its own.
    if (this.status.organizationId !== null) log.info('runner_grant_unshared', { hostId: link.hostId, code: code ?? null })
    this.grant = null
    this.setOrganization(null)
    this.status.error = null
    return 'unshared'
  }

  private async deliverOutbox(grant: RunnerGrant, hostId: string, ops: ReturnType<typeof listCloudOutboxOps>): Promise<'ok' | 'unauthorized' | 'failed'> {
    const body: RunnerOutboxRequest = { hostId, ops }
    const answered = await this.post(grant, RUNNER_OUTBOX_PATH, body)
    if (answered.kind !== 'ok') return answered.kind
    const parsed = runnerOutboxResponseSchema.safeParse(answered.body)
    if (!parsed.success) {
      this.fail('runner_outbox_unreadable', new Error('The workspace answered with an unreadable outbox receipt'))
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
    const acked = ackCloudOutboxOpsThrough(parsed.data.lastSeq)
    log.info('runner_outbox_delivered', { hostId, organizationId: grant.organizationId, sent: ops.length, acked, lastSeq: parsed.data.lastSeq, failed: parsed.data.failed.length })
    const transient = parsed.data.failed.find((failure) => !failure.permanent)
    if (transient) {
      this.fail('runner_outbox_op_deferred', new Error(transient.error))
      return 'failed'
    }
    return 'ok'
  }

  private async deliverSessionReports(grant: RunnerGrant, hostId: string, reports: ReturnType<typeof listSessionReports>): Promise<'ok' | 'unauthorized' | 'failed'> {
    const body: RunnerSessionRecordsRequest = { hostId, reports }
    const answered = await this.post(grant, RUNNER_SESSION_RECORDS_PATH, body)
    if (answered.kind !== 'ok') return answered.kind
    const parsed = runnerSessionRecordsResponseSchema.safeParse(answered.body)
    if (!parsed.success) {
      this.fail('runner_session_records_unreadable', new Error('The workspace answered with an unreadable session-record receipt'))
      return 'failed'
    }
    const acked = ackSessionReportsThrough(parsed.data.lastSeq)
    log.info('runner_session_records_delivered', { hostId, organizationId: grant.organizationId, sent: reports.length, acked, lastSeq: parsed.data.lastSeq })
    return 'ok'
  }

  private async post(grant: RunnerGrant, path: string, body: RunnerOutboxRequest | RunnerSessionRecordsRequest): Promise<{ kind: 'ok'; body: unknown } | { kind: 'unauthorized' | 'failed' }> {
    let response: Response
    try {
      response = await this.request(`${grant.workspaceUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${grant.grant}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      this.fail('runner_delivery_unreachable', err instanceof Error ? err : new Error(String(err)))
      return { kind: 'failed' }
    }
    if (response.status === 401) {
      log.info('runner_delivery_unauthorized', { path })
      return { kind: 'unauthorized' }
    }
    if (!response.ok) {
      this.fail('runner_delivery_refused', new Error(`${path} answered ${response.status}`))
      return { kind: 'failed' }
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

  private setOrganization(organizationId: string | null): void {
    if (this.status.organizationId === organizationId) return
    this.status.organizationId = organizationId
    if (organizationId === null) this.status.workspaceUrl = null
    setCloudOwnedOrganization(organizationId)
    log.info('runner_delivery_organization_changed', { organizationId })
  }
}
