// Adapted from T3 Code apps/mobile/src/features/pull-requests/guide/useReviewGuide.ts (MIT, see UPSTREAM.md).
import type { PullRequest } from '@solus/contracts/providers'
import type { ReviewGuideStatusEvent } from '@solus/contracts/review'
import { Listeners } from '../../lib/listeners'
import { projectContext } from '../conversation/lib/ipc-context'
import type { HostConnection } from '../hosts/host-connections'
import { hasSavedGuide, isGuideEventFor, prGuideKey, prGuideTarget, type PullRequestGuide } from './lib/pull-request-guide-state'
import { memoryPullRequestCacheDatabase, PullRequestCache } from './pull-request-cache'
import { detailKey, type PullRequestRef } from './pull-request-directory'
import { connectedHost, HostReads, IDLE, shownValue, type LoadState } from './pull-request-reads'

/**
 * The review guide of one pull request: the host's saved-guide status, the
 * guide when there is one, and a request to write it. The host tells every
 * client when a guide changes status (`review.guideStatusChanged`), so a
 * shown pull request follows its job by those events, not by polling.
 */

type GuidePr = Pick<PullRequest, 'baseRepo' | 'number' | 'url' | 'baseSha' | 'headSha'>

function guideCacheKey(ref: PullRequestRef): string {
  return `guide:${ref.projectPath}:${ref.number}`
}

export class PullRequestGuides {
  readonly changes = new Listeners()
  private readonly guides = new Map<string, LoadState<PullRequestGuide>>()
  private readonly starting = new Set<string>()
  private readonly startErrors = new Map<string, string>()
  private readonly reads: HostReads

  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly organizationId: () => string | null,
    private readonly cache: PullRequestCache = new PullRequestCache(memoryPullRequestCacheDatabase()),
  ) {
    this.reads = new HostReads(this.changes, connectionFor, cache)
  }

  guideOf = (ref: PullRequestRef): LoadState<PullRequestGuide> => this.guides.get(detailKey(ref)) ?? IDLE

  /** True while a request to write the guide waits for the host. */
  isStarting = (ref: PullRequestRef): boolean => this.starting.has(detailKey(ref))

  /** Why the last request to write the guide failed; null after a new one. */
  startErrorOf = (ref: PullRequestRef): string | null => this.startErrors.get(detailKey(ref)) ?? null

  /** The host's status for the pull request, and the saved guide when it has one. */
  async load(ref: PullRequestRef, pr: GuidePr): Promise<void> {
    const target = prGuideTarget(pr)
    await this.reads.read(this.guides, detailKey(ref), ref.hostId, guideCacheKey(ref), async (connection, previous) => {
      const ctx = this.context(ref)
      const [answer] = await connection.api.prGuideStatuses(ctx, [{ target }])
      const status = answer && isGuideEventFor(answer, target) ? answer : null
      const guide = hasSavedGuide(status)
        ? await connection.api.readGuide(ctx, prGuideKey(target), target)
        : status ? previous?.guide ?? null : null
      return { status, guide }
    })
  }

  /** Asks the host to write the guide for the pull request's current head.
   *  A failure is kept for `startErrorOf`; it does not throw. */
  async request(ref: PullRequestRef, pr: GuidePr): Promise<void> {
    const key = detailKey(ref)
    if (this.starting.has(key)) return
    const target = prGuideTarget(pr)
    this.starting.add(key)
    this.startErrors.delete(key)
    this.changes.notify()
    try {
      const connection = connectedHost(this.connectionFor(ref.hostId))
      const event = await connection.api.requestReviewGuide(this.context(ref), { target })
      if (!event || !isGuideEventFor(event, target)) throw new Error('The host could not start the guide.')
      this.apply(ref, event.target ? event : { ...event, target })
    } catch (error) {
      this.startErrors.set(key, error instanceof Error ? error.message : String(error))
    } finally {
      this.starting.delete(key)
      this.changes.notify()
    }
  }

  /**
   * Follows the pull request's guide while its screen is shown: status
   * events update it, a guide that becomes ready is read, and a new
   * connection reads it again. Call the answer when the screen is not shown.
   */
  watch(ref: PullRequestRef, pr: GuidePr): () => void {
    const connection = this.connectionFor(ref.hostId)
    if (!connection) return () => undefined
    const target = prGuideTarget(pr)
    const stops = [
      connection.events.subscribe('review.guideStatusChanged', (event) => {
        if (!isGuideEventFor(event, target)) return
        const before = shownValue(this.guideOf(ref))?.status ?? null
        if (!this.apply(ref, event.target ? event : { ...event, target })) return
        // A finished run is read: a ready guide, or one kept after a push during the run.
        const finished = event.status === 'ready' || (event.status === 'outdated' && !!event.generatedAt)
        const written = finished && (before?.status !== event.status || before.generatedAt !== event.generatedAt)
        if (written) void this.load(ref, pr)
      }),
      connection.onAccepted(() => { void this.load(ref, pr) }),
    ]
    return () => { for (const stop of stops) stop() }
  }

  forgetHost(hostId: string): void {
    this.reads.forgetHost(this.guides, hostId)
    for (const key of Array.from(this.startErrors.keys())) if (key.startsWith(`${hostId}\u0000`)) this.startErrors.delete(key)
    for (const key of Array.from(this.starting)) if (key.startsWith(`${hostId}\u0000`)) this.starting.delete(key)
    this.changes.notify()
  }

  /** Puts a status event on the pull request's guide. An event older than the
   *  status shown, or a job step that goes back, is dropped. */
  private apply(ref: PullRequestRef, event: ReviewGuideStatusEvent): boolean {
    const key = detailKey(ref)
    const value = shownValue(this.guideOf(ref))
    const previous = value?.status ?? null
    if (previous && previous.updatedAt > event.updatedAt) return false
    if (previous && previous.updatedAt === event.updatedAt && previous.generationId === event.generationId && rank(previous) > rank(event)) return false
    // A new job does not remove the saved guide.
    const status = !event.generatedAt && previous?.generatedAt ? { ...event, generatedAt: previous.generatedAt } : event
    const next: PullRequestGuide = { status, guide: value?.guide ?? null }
    this.guides.set(key, { kind: 'loaded', value: next })
    this.changes.notify()
    void this.cache.write(ref.hostId, guideCacheKey(ref), next)
    return true
  }

  private context(ref: PullRequestRef) {
    return projectContext(ref.projectPath, this.organizationId())
  }
}

function rank(event: ReviewGuideStatusEvent): number {
  return event.status === 'queued' ? 0 : event.status === 'generating' ? 1 : 2
}
