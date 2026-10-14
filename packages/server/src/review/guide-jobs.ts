import { randomUUID } from 'node:crypto'
import type { ReviewGuide, ReviewGuideRequestOptions, ReviewGuideStatus, ReviewGuideStatusEvent, ReviewProgressStep } from '@solus/contracts/review'
import type { IpcContext, SessionCtx } from '@solus/contracts/types'
import type { AgentDispatcher } from '../execution/agents/agent-runner'
import type { SeatResolver } from '../execution/seats/seat-manager'
import { runBounded } from '../lib/concurrency'
import { createLogger } from '../logger'
import { requireActingScope, withActingScope } from '../vault/acting-scope'
import type { GeneratedGuide } from './guide-producer'
import type { CheckoutFactsCache } from './review-context'

const log = createLogger('review', 'guide-jobs.ts')

/** The facts that name one revision of a change: the exact patch, or the head and base. */
export type GuideRevision = Pick<ReviewGuideStatusEvent, 'headSha' | 'baseSha' | 'changeFingerprint'>

/** The fields of a status event that name a guide and the revision it reads. */
export type GuideIdentity = Pick<ReviewGuideStatusEvent, 'repoRoot' | 'key' | 'scope' | 'target'> & GuideRevision

/** A guide a request names. `jobKey` is one per guide, across checkouts. */
export interface GuideSubject {
  jobKey: string
  identity: GuideIdentity
}

export interface GuideAuthoring {
  ctx: IpcContext
  opts: ReviewGuideRequestOptions
  dispatcher: AgentDispatcher
  seatFor?: SeatResolver
  identity: GuideIdentity
  signal: AbortSignal
  progress: (step: ReviewProgressStep) => void
  /** Fixes the revision the run reads, before the model starts. */
  reading: (revision: Partial<GuideIdentity>) => void
}

/**
 * One kind of review target: how to name its guide, where the guide is saved,
 * which revision is live, and how to author one. The job owner does the rest.
 */
export interface GuideSource {
  /** Runs one guide at a time on the host; otherwise runs in parallel. */
  serial: boolean
  /** Names the guide a request is about; null when there is nothing to review.
   * `withRevision` also reads the revision a run would read now. A status probe
   * skips that cost. `checkouts` lets a batch read one checkout once. */
  identify(
    ctx: Pick<IpcContext, 'session'>,
    opts: ReviewGuideRequestOptions,
    options: { withRevision: boolean; checkouts?: CheckoutFactsCache },
  ): Promise<GuideSubject | null>
  read(identity: GuideIdentity): Promise<ReviewGuide | null>
  /** The live revision. A pull request asks its code host. */
  live(ctx: Pick<IpcContext, 'session'>, identity: GuideIdentity): Promise<Partial<GuideIdentity> & GuideRevision>
  author(run: GuideAuthoring): Promise<GeneratedGuide | null>
  write(identity: GuideIdentity, guide: ReviewGuide, canCommit: () => boolean): Promise<boolean>
}

export interface GuideJobRequest {
  ctx: IpcContext
  opts: ReviewGuideRequestOptions
  dispatcher: AgentDispatcher
  /** The requester's own provider login for each backend. */
  seatFor?: SeatResolver
  /** Hears this request's job only, joined or new. Every status is published either way. */
  onStatus?: (event: ReviewGuideStatusEvent) => void
}

interface GuideJob {
  key: string
  source: GuideSource
  request: GuideJobRequest
  listeners: ((event: ReviewGuideStatusEvent) => void)[]
  controller: AbortController
  event: ReviewGuideStatusEvent
  completion: Promise<GeneratedGuide | null>
}

const ACTIVE: ReviewGuideStatus[] = ['queued', 'generating']

function isActive(job: GuideJob): boolean {
  return ACTIVE.includes(job.event.status)
}

/** Two revisions differ when a fact both of them name differs: the patch
 * fingerprint when both have one, or else the head or the base. A fact one
 * side does not know yet does not make them differ. */
export function revisionsDiffer(a: GuideRevision, b: GuideRevision): boolean {
  if (a.changeFingerprint && b.changeFingerprint) return a.changeFingerprint !== b.changeFingerprint
  return !!(a.headSha && b.headSha && a.headSha !== b.headSha)
    || !!(a.baseSha && b.baseSha && a.baseSha !== b.baseSha)
}

/** Against the live revision: why the last job for it ended, or whether the
 * saved guide still describes the change. */
function settledStatus(
  identity: GuideIdentity,
  live: Partial<GuideIdentity> & GuideRevision,
  guide: ReviewGuide | null,
  last: ReviewGuideStatusEvent | undefined,
): ReviewGuideStatusEvent {
  if (last && last.status !== 'ready' && !revisionsDiffer(last, live)) {
    return { ...last, generatedAt: guide?.generatedAt ?? last.generatedAt }
  }
  return {
    ...identity, ...live,
    status: guide ? revisionsDiffer(guide, live) ? 'outdated' : 'ready' : last?.status ?? 'failed',
    changeFingerprint: live.changeFingerprint ?? guide?.changeFingerprint,
    generatedAt: guide?.generatedAt, updatedAt: Date.now(),
  }
}

function errorMessage(error: Parameters<typeof String>[0]): string {
  return error instanceof Error ? error.message : String(error)
}

/** Each probe costs a few git spawns and a diff. A restored workspace sends
 * one probe per tab, so a batch is paced to leave the CPU to the transcript
 * that is loading at the same time. */
const PROBE_CONCURRENCY = 4

/**
 * The one owner of running review guides (docs/review-guides.md).
 *
 * One job per guide: the guide is the key, and the revision it reads lives in
 * the job. A request for the revision a job reads joins it; a request for
 * another revision replaces it. Only the current job may write, so a slow run
 * never overwrites a newer one. A run whose change moved while it was written
 * still saves its guide, which then reads as outdated. Every status goes out
 * through `publish`. The last job per guide stays after it ends, so a client
 * that reconnects sees why it ended. A host restart drops a running job.
 */
export class ReviewGuideJobs {
  private readonly jobs = new Map<string, GuideJob>()
  /** Serial sources share one model queue. It starts only after the queued state is readable. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly publish: (event: ReviewGuideStatusEvent) => void,
    private readonly sources: { pr: GuideSource; local: GuideSource },
  ) {}

  private sourceFor(opts: ReviewGuideRequestOptions): GuideSource {
    return opts.target?.kind === 'pr' ? this.sources.pr : this.sources.local
  }

  /** Start, join, or replace the job for the guide a request names. Null when
   * there is nothing to review. */
  async request(request: GuideJobRequest): Promise<{ status: ReviewGuideStatusEvent; completion: Promise<GeneratedGuide | null> } | null> {
    const source = this.sourceFor(request.opts)
    const subject = await source.identify(request.ctx, request.opts, { withRevision: true })
    if (!subject) return null
    const running = this.jobs.get(subject.jobKey)
    if (running && isActive(running) && !revisionsDiffer(subject.identity, running.event)) {
      if (request.onStatus) {
        running.listeners.push(request.onStatus)
        request.onStatus(running.event)
      }
      return { status: running.event, completion: running.completion }
    }
    if (running) this.stop(running)
    const job: GuideJob = {
      key: subject.jobKey, source, request, listeners: request.onStatus ? [request.onStatus] : [],
      controller: new AbortController(),
      event: { ...subject.identity, status: 'queued', generationId: randomUUID(), updatedAt: Date.now() },
      completion: Promise.resolve(null),
    }
    // Each run acts for whoever asked for it (plans/019).
    const scope = requireActingScope('a review guide')
    const start = () => withActingScope(scope, () => this.run(job))
    this.jobs.set(subject.jobKey, job)
    this.emit(job)
    if (source.serial) {
      job.completion = this.tail.then(start)
      this.tail = job.completion.catch(() => {})
    } else {
      job.completion = start()
    }
    return { status: job.event, completion: job.completion }
  }

  /** Stop the running job for the guide a request names, whatever revision it reads. */
  async cancel(ctx: Pick<IpcContext, 'session'>, opts: ReviewGuideRequestOptions): Promise<boolean> {
    const subject = await this.sourceFor(opts).identify(ctx, opts, { withRevision: false })
    const job = subject ? this.jobs.get(subject.jobKey) : undefined
    if (!job || !isActive(job)) return false
    this.stop(job)
    return true
  }

  /**
   * The guide's state against the live revision: the running job, why the
   * last one ended, or whether the saved guide still describes the change.
   * Null when there is no guide and no job. Never runs a model.
   */
  async status(
    ctx: Pick<IpcContext, 'session'>,
    opts: ReviewGuideRequestOptions,
    checkouts?: CheckoutFactsCache,
  ): Promise<ReviewGuideStatusEvent | null> {
    const source = this.sourceFor(opts)
    const subject = await source.identify(ctx, opts, { withRevision: false, checkouts })
    if (!subject) return null
    const job = this.jobs.get(subject.jobKey)
    if (job && isActive(job)) return job.event
    // A job can start while the guide or the live revision is read.
    const started = () => {
      const latest = this.jobs.get(subject.jobKey)
      return latest && (latest !== job || isActive(latest)) ? latest.event : null
    }
    // With no guide and no job the answer is null, and the live revision is
    // not needed to say so.
    const guide = await source.read(subject.identity)
    if (started()) return started()
    if (!guide && !job) return null
    try {
      const live = await source.live(ctx, subject.identity)
      return started() ?? settledStatus(subject.identity, live, guide, job?.event)
    } catch (error) {
      return started() ?? {
        ...subject.identity, status: 'failed', updatedAt: Date.now(),
        error: `Could not check the current revision: ${errorMessage(error)}`,
      }
    }
  }

  /** Status for many guides, in request order. One failure answers null for
   * that guide and does not fail the batch. */
  statuses(requests: { ctx: Pick<IpcContext, 'session'>; opts: ReviewGuideRequestOptions }[]): Promise<(ReviewGuideStatusEvent | null)[]> {
    // Restored tabs mostly share one checkout. Its branch, target, and head are
    // read once for the batch instead of once per guide.
    const checkouts: CheckoutFactsCache = new Map()
    return runBounded(requests.map(({ ctx, opts }) => async () => {
      try {
        return await this.status(ctx, opts, checkouts)
      } catch (error) {
        log.warn('guide_status_failed', { sessionId: ctx.session.sessionId, error: errorMessage(error) })
        return null
      }
    }), PROBE_CONCURRENCY)
  }

  /** Status of the saved guides of many sessions, as a restored workspace asks. */
  sessionStatuses(sessions: SessionCtx[]): Promise<(ReviewGuideStatusEvent | null)[]> {
    return this.statuses(sessions.map((session) => ({ ctx: { session }, opts: { scope: 'session' } })))
  }

  /**
   * What a list needs to mark a row: the running job, or the saved guide at the
   * revision it was written for. Reads host storage only, so a page of rows is
   * never a page of code-host requests. The list compares the saved head with
   * the head it holds; `status` does the full check.
   */
  async savedStatus(ctx: Pick<IpcContext, 'session'>, opts: ReviewGuideRequestOptions): Promise<ReviewGuideStatusEvent | null> {
    const source = this.sourceFor(opts)
    const subject = await source.identify(ctx, opts, { withRevision: false })
    if (!subject) return null
    const running = () => {
      const latest = this.jobs.get(subject.jobKey)
      return latest && isActive(latest) ? latest.event : null
    }
    if (running()) return running()
    const guide = await source.read(subject.identity)
    if (running()) return running()
    const job = this.jobs.get(subject.jobKey)
    if (job && job.event.headSha === subject.identity.headSha) return { ...job.event, generatedAt: guide?.generatedAt }
    if (!guide) return null
    return {
      ...subject.identity, status: 'ready', updatedAt: Date.now(),
      headSha: guide.headSha, baseSha: guide.baseSha, changeFingerprint: guide.changeFingerprint, generatedAt: guide.generatedAt,
    }
  }

  private stop(job: GuideJob): void {
    if (!isActive(job)) return
    job.controller.abort()
    this.update(job, { status: 'cancelled', step: undefined })
  }

  private isCurrent(job: GuideJob): boolean {
    return !job.controller.signal.aborted && this.jobs.get(job.key) === job
  }

  private emit(job: GuideJob): void {
    this.publish(job.event)
    for (const listener of job.listeners) listener(job.event)
  }

  private update(job: GuideJob, patch: Partial<ReviewGuideStatusEvent>): void {
    if (this.jobs.get(job.key) !== job) return
    job.event = { ...job.event, ...patch, updatedAt: Date.now() }
    this.emit(job)
  }

  private async run(job: GuideJob): Promise<GeneratedGuide | null> {
    if (!this.isCurrent(job)) return null
    const { source, request } = job
    try {
      this.update(job, { status: 'generating', step: 'preparing' })
      const generated = await source.author({
        ctx: request.ctx, opts: request.opts, dispatcher: request.dispatcher, seatFor: request.seatFor,
        identity: job.event, signal: job.controller.signal,
        progress: (step) => { if (this.isCurrent(job)) this.update(job, { status: 'generating', step }) },
        reading: (revision) => { if (this.isCurrent(job)) this.update(job, revision) },
      })
      if (!this.isCurrent(job)) return null
      if (!generated) throw new Error('There is no change to review here.')
      // A fallback (nothing to review, agent failure) is shown but never saved.
      if (!generated.authored) {
        this.update(job, { status: 'failed', step: undefined, error: generated.guide.summary })
        return generated
      }
      return await this.commit(job, generated)
    } catch (error) {
      if (this.isCurrent(job)) this.update(job, { status: 'failed', step: undefined, error: errorMessage(error) })
      return null
    }
  }

  /** Save the authored guide for the revision the run read. A change that
   * moved meanwhile still gets it, marked outdated, unless a guide for the live
   * revision is already saved. */
  private async commit(job: GuideJob, generated: GeneratedGuide): Promise<GeneratedGuide | null> {
    const { source } = job
    const read: GuideIdentity = job.event
    const live = await source.live(job.request.ctx, read).catch(() => read)
    if (!this.isCurrent(job)) return null
    const outdated = revisionsDiffer(read, live)
    const saved = outdated ? await source.read(read) : null
    if (!this.isCurrent(job)) return null
    if (saved && !revisionsDiffer(saved, live)) {
      this.update(job, { ...live, status: 'ready', step: undefined, generatedAt: saved.generatedAt, changeFingerprint: saved.changeFingerprint })
      return { key: read.key, guide: saved, persisted: true, authored: true }
    }
    const guide: ReviewGuide = { ...generated.guide, key: read.key, target: read.target }
    const persisted = await source.write(read, guide, () => this.isCurrent(job))
    if (!this.isCurrent(job)) return null
    if (!persisted) throw new Error('The guide could not be saved. Try again.')
    this.update(job, {
      ...live, status: outdated ? 'outdated' : 'ready', step: undefined,
      generatedAt: guide.generatedAt, changeFingerprint: live.changeFingerprint ?? guide.changeFingerprint,
    })
    return { ...generated, guide, persisted: true, outdated }
  }
}
