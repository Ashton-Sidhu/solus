import { withTx } from '../db'
import type { ShareResource } from '@solus/contracts/sharing'
import type { Publication, PublicationStartRequest } from '@solus/contracts/organization-scope'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import { createLogger } from '../logger'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../admission/principal'
import { assignSessionOrganization, getSessionRecord, markSessionPublished, recordSessionId } from '../data/sessions/session-records'
import { exportWorkForCloud, removePushedWork } from '../data/works/works'
import { Work } from '../data/works/work'
import { Task } from '../data/tasks/task'
import { mirrorPendingThrough } from './mirror/mirror-log'
import { publicationOutboxPending, queueSessionReport, recordOutboxOp, sessionReportPendingThrough } from './outbox/outbox-store'
import { RUNNER_WORKS_PATH, runnerWorkResponseSchema, type RunnerWorkRequest } from './runner-protocol'
import type { TranscriptMirror, TranscriptSource } from './mirror/transcript-mirror'
import type { RunnerDelivery } from './runner-delivery'
import type { DeliveryDestination } from './outbox/outbox-store'
import { activePublication, insertPublication, listActivePublications, listPublications, readPublication, updatePublication, type PublicationRow } from './publication-store'

const log = createLogger('main', 'publication')

/**
 * Publication (organization-scope §7): the one recoverable operation that moves
 * a Local work, session, or task into one organization on the Solus API. Share
 * and Move both start one; opening or cancelling Share starts none.
 *
 * Order of events for every kind: reserve the destination first (a `pending`
 * row, unique per resource, so a concurrent Share B or an Insights assignment
 * cannot choose another organization), then send, then wait for the service's
 * receipt, then commit the record's new state. A failure keeps the row and its
 * story; a restart resumes what is `pending` or `sent`.
 *
 * - A **work** is exported with its complete history and annotations, posted
 *   to the organization's service under this host's runner grant (the service
 *   imports it atomically, or answers that the same content is already there),
 *   and only then removed here — unless it changed meanwhile, in which case the
 *   local copy is kept and the publication fails.
 * - A **session** is assigned to the organization if it was unassigned, waits
 *   for its turn to settle, has its record reported and its transcript
 *   mirrored, and is `published` once the service acknowledged both.
 * - A **task** travels as outbox ops — its creation and its comments — and its
 *   local row leaves once the service applied them.
 */

export interface PublicationDeps {
  delivery: RunnerDelivery
  transcriptMirror: TranscriptMirror
  /** The runtime's view of a session: how its transcript is read, and whether a turn is running. */
  transcriptSource: (sessionId: string) => (TranscriptSource & { agentSessionId: string }) | null
  isTurnRunning: (sessionId: string) => boolean
  hostId: () => string | null
  onChanged: (publication: Publication) => void
  /** Drop the share rows of a resource that left this host. */
  forgetResource?: (resource: ShareResource) => Promise<void>
  /** How long to wait for a turn to settle or a receipt to arrive before the publication stays where it is. */
  waitMs?: number
  pollMs?: number
}

export class PublicationCoordinator {
  private readonly running = new Map<string, Promise<void>>()

  constructor(private readonly deps: PublicationDeps) {}

  /** Every publication of a resource, or the host's recent ones. */
  list(resource?: ShareResource): Publication[] {
    return listPublications(resource).map(toPublication)
  }

  /** The organization a resource is on its way to, if a publication is active: what a first Insights assignment must respect. */
  reservedOrganization(resource: ShareResource): string | null {
    return activePublication(resource)?.organizationId ?? null
  }

  /**
   * Start, or resume, the publication of one resource into one organization.
   * Answers the row as it stands after the reservation; the work continues in
   * the background and `onChanged` reports every state.
   */
  async start(request: PublicationStartRequest, actorUserId: string): Promise<Publication> {
    if (request.organizationId === LOCAL_ORGANIZATION_ID) throw new Error('Choose an organization to publish to.')
    const active = activePublication(request.resource)
    if (active) {
      if (active.organizationId !== request.organizationId) {
        throw new Error('This resource is already on its way to another organization. Wait for that publication to finish.')
      }
      this.drive(active.id)
      return toPublication(active)
    }
    const home = await this.currentOrganization(request.resource)
    if (home !== null && home !== LOCAL_ORGANIZATION_ID && home !== request.organizationId) {
      throw new Error('This resource belongs to another organization and cannot move between organizations.')
    }
    const row = insertPublication({ resource: request.resource, organizationId: request.organizationId, actorUserId })
    this.deps.onChanged(toPublication(row))
    this.drive(row.id)
    return toPublication(row)
  }

  /** At boot, and after every delivery cycle: pick up what is still on its way. */
  resume(): void {
    for (const row of listActivePublications()) this.drive(row.id)
  }

  private drive(id: string): void {
    if (this.running.has(id)) return
    const run = this.run(id).catch((error) => {
      log.warn('publication_run_failed', { publicationId: id, error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { this.running.delete(id) })
    this.running.set(id, run)
  }

  private async run(id: string): Promise<void> {
    const row = readPublication(id)
    if (!row || (row.state !== 'pending' && row.state !== 'sent')) return
    switch (row.resource.kind) {
      case 'work': return this.publishWork(row)
      case 'session': return this.publishSession(row)
      case 'task': return this.publishTask(row)
    }
  }

  private async currentOrganization(resource: ShareResource): Promise<string | null> {
    switch (resource.kind) {
      case 'session': return (await getSessionRecord(ANY_ORGANIZATION, recordSessionId(resource.id)))?.organizationId ?? null
      case 'work': return (await Work.find(ANY_ORGANIZATION, resource.id))?.organizationId ?? null
      case 'task': {
        try { return (await Task.byId(ANY_ORGANIZATION, resource.id)).organizationId } catch { return null }
      }
    }
  }

  // ── Works ────────────────────────────────────────────────────────────────

  private async publishWork(row: PublicationRow): Promise<void> {
    const hostId = this.deps.hostId()
    if (!hostId) return this.fail(row, 'This host is not linked to Solus cloud.')
    let transfer: WorkTransfer
    try {
      transfer = await exportWorkForCloud(ANY_ORGANIZATION, row.resource.id)
    } catch (error) {
      return this.fail(row, error instanceof Error ? error.message : String(error))
    }
    if (transfer.work.organizationId !== LOCAL_ORGANIZATION_ID && transfer.work.organizationId !== row.organizationId) {
      return this.fail(row, 'This work belongs to another organization.')
    }
    const sent = updatePublication(row.id, { state: 'sent', fingerprint: transfer.fingerprint })
    if (row.state !== 'sent') this.deps.onChanged(toPublication(sent))
    const destination = { organizationId: row.organizationId, actorUserId: row.actorUserId }
    const body: RunnerWorkRequest = { hostId, transfer, actorUserId: row.actorUserId }
    const answer = await this.deps.delivery.call(destination, RUNNER_WORKS_PATH, body, runnerWorkResponseSchema)
    if (answer.kind === 'refused') return this.fail(sent, answer.error ?? `The organization's service refused the work (${answer.status}).`)
    if (answer.kind !== 'ok') {
      // Unreachable or no grant yet: the reservation holds and the next delivery cycle tries again.
      if (!this.waitingOnPerson(sent, destination)) log.info('publication_deferred', { publicationId: row.id, reason: answer.kind })
      return
    }
    try {
      await removePushedWork(ANY_ORGANIZATION, row.resource.id, transfer.fingerprint)
    } catch (error) {
      // The work changed while it travelled: the cloud has the old version, the newer local copy is kept.
      return this.fail(sent, error instanceof Error ? error.message : String(error))
    }
    await this.deps.forgetResource?.(row.resource)
    this.commit(sent)
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  private async publishSession(row: PublicationRow): Promise<void> {
    const sessionId = row.resource.id
    // A client names the Solus session id; the record is keyed by the provider thread id.
    const recordId = recordSessionId(sessionId)
    const record = await getSessionRecord(ANY_ORGANIZATION, recordId)
    if (!record) return this.fail(row, 'This session has no record on this host.')
    if (record.organizationId !== row.organizationId) {
      const assigned = await assignSessionOrganization(recordId, row.organizationId)
      if (!assigned || assigned.organizationId !== row.organizationId) return this.fail(row, 'This session belongs to another organization.')
    }
    if (!this.deps.hostId()) return this.fail(row, 'This host is not linked to Solus cloud.')
    // A turn boundary: the snapshot is taken between turns, never through one.
    const settled = await this.waitUntil(() => !this.deps.isTurnRunning(sessionId))
    if (!settled) {
      log.info('publication_waiting_for_turn', { publicationId: row.id, sessionId })
      return
    }
    // The record is reported and the transcript read once; the record says
    // `published` only after the service acknowledged both (§7).
    const current = await getSessionRecord(row.organizationId, recordId)
    if (!current) return this.fail(row, 'This session belongs to another organization.')
    const destination = { organizationId: row.organizationId, actorUserId: current.ownerUserId ?? row.actorUserId }
    const reportSeq = queueSessionReport(destination, { ...current, runnerHostId: this.deps.hostId()! })
    // A live session's history is read the way the runtime reads it; a session
    // that is not running is read from its record's provider and thread id.
    const source = this.deps.transcriptSource(sessionId) ?? { provider: current.provider, agentSessionId: recordId }
    this.deps.transcriptMirror.touch(source.agentSessionId, source)
    const mirrorSeq = await this.deps.transcriptMirror.flushNow(source.agentSessionId)
    const throughSeq = Math.max(row.throughSeq ?? 0, reportSeq, mirrorSeq)
    const sent = updatePublication(row.id, { state: 'sent', throughSeq })
    if (row.state !== 'sent') this.deps.onChanged(toPublication(sent))
    if (this.waitingOnPerson(sent, destination)) return
    this.deps.delivery.kick()
    const received = () => !sessionReportPendingThrough(row.organizationId, throughSeq) && !mirrorPendingThrough(row.organizationId, throughSeq)
    await this.waitUntil(() => received() || this.deps.delivery.waitingReason(destination) !== null)
    if (!received()) {
      if (!this.waitingOnPerson(sent, destination)) log.info('publication_waiting_for_receipt', { publicationId: row.id, sessionId, throughSeq })
      return
    }
    await markSessionPublished(recordId)
    this.commit(sent)
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  private async publishTask(row: PublicationRow): Promise<void> {
    const hostId = this.deps.hostId()
    if (!hostId) return this.fail(row, 'This host is not linked to Solus cloud.')
    let task: Task
    try {
      task = await Task.byId(ANY_ORGANIZATION, row.resource.id)
    } catch {
      return this.fail(row, 'This task no longer exists on this host.')
    }
    if (task.organizationId !== LOCAL_ORGANIZATION_ID && task.organizationId !== row.organizationId) {
      return this.fail(row, 'This task belongs to another organization.')
    }
    const details = row.state === 'pending' ? await task.details() : null
    const sent = withTx(() => {
      let throughSeq = row.throughSeq ?? 0
      if (details) {
        const created = recordOutboxOp({
          domain: 'tasks',
          resourceId: task.id,
          name: 'create',
          destination: 'cloud',
          organizationId: row.organizationId,
          actorUserId: row.actorUserId,
          publicationId: row.id,
          payload: {
            title: task.title,
            projectKey: task.projectKey ?? null,
            body: task.body,
            priority: task.priority ?? null,
            labels: task.labels,
            dueDate: task.dueDate ?? null,
            status: task.status,
            originSessionId: task.originSessionId ?? null,
            createdAt: task.createdAt,
          },
        })
        throughSeq = created.seq
        for (const comment of details.comments) {
          if (comment.source !== 'local') continue
          const op = recordOutboxOp({
            domain: 'tasks',
            resourceId: task.id,
            name: 'comment',
            destination: 'cloud',
            organizationId: row.organizationId,
            actorUserId: row.actorUserId,
            publicationId: row.id,
            payload: { body: comment.body, author: comment.author ?? 'Host owner', originSessionId: comment.originSessionId ?? undefined },
          })
          throughSeq = Math.max(throughSeq, op.seq)
        }
      }
      return updatePublication(row.id, { state: 'sent', throughSeq })
    })
    if (row.state !== 'sent') this.deps.onChanged(toPublication(sent))
    const destination = { organizationId: row.organizationId, actorUserId: row.actorUserId }
    if (this.waitingOnPerson(sent, destination)) return
    this.deps.delivery.kick()
    await this.waitUntil(() => readPublication(row.id)?.state === 'failed' || !publicationOutboxPending(row.id) || this.deps.delivery.waitingReason(destination) !== null)
    const result = readPublication(row.id)
    if (result?.state === 'failed') {
      this.deps.onChanged(toPublication(result))
      return
    }
    if (publicationOutboxPending(row.id)) {
      if (!this.waitingOnPerson(sent, destination)) log.info('publication_waiting_for_receipt', { publicationId: row.id, taskId: task.id, throughSeq: sent.throughSeq })
      return
    }
    // The service holds it now; the local row and its shares leave, as a published work's do.
    await task.delete()
    await this.deps.forgetResource?.(row.resource)
    this.commit(sent)
  }

  // ── Shared ───────────────────────────────────────────────────────────────

  private commit(row: PublicationRow): void {
    const committed = updatePublication(row.id, { state: 'committed', error: null })
    log.info('publication_committed', { publicationId: row.id, kind: row.resource.kind, resourceId: row.resource.id, organizationId: row.organizationId })
    this.deps.onChanged(toPublication(committed))
  }

  private fail(row: PublicationRow, error: string): void {
    const failed = updatePublication(row.id, { state: 'failed', error })
    log.warn('publication_failed', { publicationId: row.id, kind: row.resource.kind, resourceId: row.resource.id, organizationId: row.organizationId, error })
    this.deps.onChanged(toPublication(failed))
  }

  /**
   * Whether delivery waits for the person to connect before it can send as them. A
   * `sent` row carries that reason as its error, and drops it once delivery can go,
   * so a client shows what to do instead of waiting for a receipt that is not coming.
   * The publication stays `sent`; the delivery cycle after the person connects resumes it.
   */
  private waitingOnPerson(row: PublicationRow, destination: DeliveryDestination): boolean {
    const reason = this.deps.delivery.waitingReason(destination)
    if ((row.error ?? null) !== reason) {
      if (reason) log.info('publication_waiting_for_person', { publicationId: row.id, reason })
      this.deps.onChanged(toPublication(updatePublication(row.id, { error: reason })))
    }
    return reason !== null
  }

  /** Polls `condition` until it holds or the wait runs out; answers whether it held. */
  private async waitUntil(condition: () => boolean): Promise<boolean> {
    const waitMs = this.deps.waitMs ?? 60_000
    const pollMs = this.deps.pollMs ?? 500
    const deadline = Date.now() + waitMs
    for (;;) {
      if (condition()) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
}

function toPublication(row: PublicationRow): Publication {
  const { fingerprint: _fingerprint, throughSeq: _throughSeq, ...publication } = row
  return publication
}

