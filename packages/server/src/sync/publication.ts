import type { ShareResource } from '@solus/contracts/sharing'
import type { Publication, PublicationStartRequest } from '@solus/contracts/organization-scope'
import { createLogger } from '../logger'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../admission/principal'
import { assignSessionOrganization, getSessionRecord, markSessionPublished } from '../data/sessions/session-records'
import { mirrorPendingThrough } from './mirror/mirror-log'
import { queueSessionReport, sessionReportPendingThrough } from './outbox/outbox-store'
import type { TranscriptMirror, TranscriptSource } from './mirror/transcript-mirror'
import type { RunnerDelivery } from './runner-delivery'
import type { DeliveryDestination } from './outbox/outbox-store'
import { activePublication, insertPublication, listActivePublications, listPublications, readPublication, updatePublication, type PublicationRow } from './publication-store'

const log = createLogger('main', 'publication')

/**
 * Publication (organization-scope §7): the one recoverable operation that moves
 * a Local session into one organization on the Solus API. Share and Move both
 * start one; opening or cancelling Share starts none. A work or a task does not
 * come here: the client uploads it to the Solus API with its own sign-in
 * (docs/plans/cloud-sharing.md). A session needs this host because the host
 * keeps sending its later turns.
 *
 * Order of events: reserve the destination first (a `pending`
 * row, unique per resource, so a concurrent Share B or an Insights assignment
 * cannot choose another organization), then send, then wait for the service's
 * receipt, then commit the record's new state. A failure keeps the row and its
 * story; a restart resumes what is `pending` or `sent`.
 *
 * A session is assigned to the organization if it was unassigned, has its
 * record reported and its transcript mirrored at once, and is `published` once
 * the service acknowledged both. A turn that is running does not hold Share:
 * the mirror keeps sending its rows as they change. Nothing here polls: the
 * receipt is checked when a delivery cycle ends, which `resume` is called on.
 */

export interface PublicationDeps {
  delivery: RunnerDelivery
  transcriptMirror: TranscriptMirror
  /** The runtime's view of a session: how its transcript is read, and whether a turn is running. */
  transcriptSource: (sessionId: string) => TranscriptSource | null
  hostId: () => string | null
  onChanged: (publication: Publication) => void
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
    if (request.resource.kind !== 'session') throw new Error(`A ${request.resource.kind} is shared through Solus cloud with your sign-in, not by this machine.`)
    const active = activePublication(request.resource)
    if (active) {
      if (active.organizationId !== request.organizationId) {
        throw new Error('This resource is already on its way to another organization. Wait for that publication to finish.')
      }
      this.drive(active.id)
      return toPublication(active)
    }
    const home = (await getSessionRecord(ANY_ORGANIZATION, request.resource.id))?.organizationId ?? null
    if (home !== null && home !== LOCAL_ORGANIZATION_ID && home !== request.organizationId) {
      throw new Error('This resource belongs to another organization and cannot move between organizations.')
    }
    const row = insertPublication({ resource: request.resource, organizationId: request.organizationId, actorUserId })
    this.deps.onChanged(toPublication(row))
    this.drive(row.id)
    return toPublication(row)
  }

  /** At boot, and after every delivery cycle: send what is `pending`, and commit what the service received. */
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
      case 'session': return row.state === 'pending' ? this.publishSession(row) : this.confirmSession(row)
      // A row from before works and tasks were uploaded by the client: nothing here sends it any more.
      default: return this.fail(row, `Share this ${row.resource.kind} again: it is now uploaded with your sign-in.`)
    }
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  private async publishSession(row: PublicationRow): Promise<void> {
    const sessionId = row.resource.id
    const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
    if (!record) return this.fail(row, 'This session has no record on this host.')
    if (record.organizationId !== row.organizationId) {
      const assigned = await assignSessionOrganization(sessionId, row.organizationId)
      if (!assigned || assigned.organizationId !== row.organizationId) return this.fail(row, 'This session belongs to another organization.')
    }
    if (!this.deps.hostId()) return this.fail(row, 'This host is not linked to Solus cloud.')
    // The record is reported and the transcript read once; the record says
    // `published` only after the service acknowledged both (§7).
    const current = await getSessionRecord(row.organizationId, sessionId)
    if (!current) return this.fail(row, 'This session belongs to another organization.')
    const destination = destinationOf(row, current.ownerUserId)
    const reportSeq = queueSessionReport(destination, { ...current, runnerHostId: this.deps.hostId()! })
    // A live session's history is read the way the runtime reads it; a session
    // that is not running is read from its record's provider and lineage.
    const source = this.deps.transcriptSource(sessionId) ?? { provider: current.provider }
    this.deps.transcriptMirror.touch(sessionId, source)
    const mirrorSeq = await this.deps.transcriptMirror.flushNow(sessionId)
    const throughSeq = Math.max(row.throughSeq ?? 0, reportSeq, mirrorSeq)
    const sent = updatePublication(row.id, { state: 'sent', throughSeq })
    this.deps.onChanged(toPublication(sent))
    if (this.waitingOnPerson(sent, destination)) return
    // The cycle that delivers these ends in `resume`, which commits the receipt.
    this.deps.delivery.kick()
  }

  /** A `sent` session is `published` once the service received everything through its sequence. */
  private async confirmSession(row: PublicationRow): Promise<void> {
    const record = await getSessionRecord(row.organizationId, row.resource.id)
    if (!record) return this.fail(row, 'This session belongs to another organization.')
    if (this.waitingOnPerson(row, destinationOf(row, record.ownerUserId))) return
    const throughSeq = row.throughSeq ?? 0
    if (sessionReportPendingThrough(row.organizationId, throughSeq) || mirrorPendingThrough(row.organizationId, throughSeq)) return
    await markSessionPublished(row.resource.id)
    this.commit(row)
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
}

/** The session's owner delivers it, with their delegated token; a record with no owner is delivered as the publisher. */
function destinationOf(row: PublicationRow, ownerUserId: string | null | undefined): DeliveryDestination {
  return { organizationId: row.organizationId, actorUserId: ownerUserId ?? row.actorUserId }
}

function toPublication(row: PublicationRow): Publication {
  const { fingerprint: _fingerprint, throughSeq: _throughSeq, ...publication } = row
  return publication
}

