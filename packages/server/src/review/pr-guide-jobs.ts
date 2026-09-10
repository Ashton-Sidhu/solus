import { randomUUID } from 'node:crypto'
import type { ReviewGuide, ReviewGuideRequestOptions, ReviewGuideStatusEvent, ReviewProgressStep } from '@solus/contracts/review'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import type { AgentDispatcher } from '../agents/agent-runner'
import { authorPrGuide, type GeneratedGuide } from './guide-producer'
import { currentPrGuideTarget, prepareReviewGuidePrContext, type PrGuideTarget, type ResolvedPrGuideTarget } from './pr-guide-context'
import { prGuideKey, readPrGuide, writePrGuide } from './pr-guide-store'

export interface PrGuideJobRequest {
  dispatcher: AgentDispatcher
  ctx: IpcContext
  opts: ReviewGuideRequestOptions & { target: PrGuideTarget }
  onStatus: (event: ReviewGuideStatusEvent) => void
}

export interface PrGuideJobDependencies {
  current: (target: PrGuideTarget) => Promise<ResolvedPrGuideTarget>
  prepare: (ctx: IpcContext, target: ResolvedPrGuideTarget) => Promise<{ ctx: IpcContext; target: ResolvedPrGuideTarget }>
  author: (request: PrGuideJobRequest, ctx: IpcContext, target: ResolvedPrGuideTarget, signal: AbortSignal, progress: (step: ReviewProgressStep) => void) => Promise<GeneratedGuide | null>
  read: (ctx: IpcContext, target: PrGuideTarget) => Promise<ReviewGuide | null>
  write: (guide: ReviewGuide, target: PrGuideTarget, canCommit: () => boolean) => Promise<boolean>
}

interface PrGuideJob {
  request: PrGuideJobRequest
  controller: AbortController
  event: ReviewGuideStatusEvent
  completion: Promise<GeneratedGuide | null>
}

const defaultDependencies: PrGuideJobDependencies = {
  current: currentPrGuideTarget,
  prepare: prepareReviewGuidePrContext,
  author: (request, ctx, target, signal, progress) => authorPrGuide(request.dispatcher, ctx, {
    ...request.opts, target, ownDeltaBase: undefined, regenerationBaseSha: undefined,
  }, signal, progress),
  read: readPrGuide,
  write: writePrGuide,
}

function sameRevision(a: { baseSha?: string; headSha?: string }, b: { baseSha?: string; headSha?: string }): boolean {
  return a.baseSha === b.baseSha && a.headSha === b.headSha
}

/** One host-owned job and saved result per PR. Navigation never owns a run.
 * The shared model queue starts only after the queued state is readable. */
export class PrGuideJobs {
  private readonly jobs = new Map<string, PrGuideJob>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly dependencies: PrGuideJobDependencies = defaultDependencies) {}

  request(request: PrGuideJobRequest) {
    const key = prGuideKey(request.opts.target)
    this.cancel(request.opts.target)
    const event: ReviewGuideStatusEvent = {
      repoRoot: request.ctx.session.gitContext?.repoRoot ?? projectScopeOf(request.ctx.session),
      key,
      scope: 'pr',
      target: request.opts.target,
      status: 'queued',
      headSha: request.opts.target.headSha ?? '',
      baseSha: request.opts.target.baseSha,
      generationId: randomUUID(),
      updatedAt: Date.now(),
    }
    const job: PrGuideJob = {
      request, event, controller: new AbortController(), completion: Promise.resolve(null),
    }
    this.jobs.set(key, job)
    request.onStatus(event)
    job.completion = this.tail.then(() => this.run(job))
    this.tail = job.completion.catch(() => {})
    return { status: event, completion: job.completion }
  }

  cancel(target: PrGuideTarget): boolean {
    const job = this.jobs.get(prGuideKey(target))
    if (!job || !['queued', 'generating'].includes(job.event.status)) return false
    job.controller.abort()
    this.update(job, { status: 'cancelled', step: undefined })
    return true
  }

  async status(ctx: IpcContext, target: PrGuideTarget): Promise<ReviewGuideStatusEvent | null> {
    const key = prGuideKey(target)
    const job = this.jobs.get(key)
    if (job && ['queued', 'generating'].includes(job.event.status)) return job.event
    const guide = await this.dependencies.read(ctx, target)
    // A generation can start while the cache or provider probe is in flight.
    const active = () => {
      const latest = this.jobs.get(key)
      return latest && (latest !== job || ['queued', 'generating'].includes(latest.event.status)) ? latest.event : null
    }
    if (active()) return active()
    if (!guide && !job) return null
    const base = cachedStatus(ctx, target, guide)
    try {
      const current = await this.dependencies.current(target)
      if (active()) return active()
      if (job && ['failed', 'cancelled'].includes(job.event.status) && sameRevision(job.event, current)) {
        return { ...job.event, generatedAt: guide?.generatedAt }
      }
      return {
        ...base, target: current, headSha: current.headSha, baseSha: current.baseSha,
        status: guide ? sameRevision(guide, current) ? 'ready' : 'outdated' : job?.event.status ?? 'failed',
        changeFingerprint: guide?.changeFingerprint,
      }
    } catch (error) {
      return active() ?? { ...base, status: 'failed', error: `Could not check the current PR revision: ${errorMessage(error)}` }
    }
  }

  private isCurrent(job: PrGuideJob): boolean {
    return !job.controller.signal.aborted && this.jobs.get(job.event.key) === job
  }

  private update(job: PrGuideJob, patch: Partial<ReviewGuideStatusEvent>): void {
    if (this.jobs.get(job.event.key) !== job) return
    job.event = { ...job.event, ...patch, updatedAt: Date.now() }
    job.request.onStatus(job.event)
  }

  private async run(job: PrGuideJob): Promise<GeneratedGuide | null> {
    if (!this.isCurrent(job)) return null
    try {
      this.update(job, { status: 'generating', step: 'preparing' })
      const target = await this.dependencies.current(job.request.opts.target)
      if (!this.isCurrent(job)) return null
      this.update(job, { target, headSha: target.headSha, baseSha: target.baseSha })
      const prepared = await this.dependencies.prepare(job.request.ctx, target)
      if (!this.isCurrent(job)) return null
      const generated = await this.dependencies.author(job.request, prepared.ctx, target,
        job.controller.signal, (step) => {
          if (this.isCurrent(job)) this.update(job, { status: 'generating', step })
        })
      if (!this.isCurrent(job)) return null
      if (!generated?.authored && !generated?.persisted) {
        throw new Error(generated?.guide.summary ?? 'The review agent did not return a guide. Try again.')
      }
      const latest = await this.dependencies.current(target)
      if (!this.isCurrent(job)) return null
      if (!sameRevision(target, latest)) {
        this.update(job, { status: 'outdated', step: undefined, target: latest, headSha: latest.headSha, baseSha: latest.baseSha })
        return { ...generated, persisted: false, outdated: true }
      }
      const guide: ReviewGuide = { ...generated.guide, key: job.event.key, target }
      const persisted = await this.dependencies.write(guide, target, () => this.isCurrent(job))
      if (!this.isCurrent(job)) return null
      if (!persisted) throw new Error('The guide could not be saved. Try again.')
      this.update(job, {
        status: 'ready', step: undefined, generatedAt: guide.generatedAt,
        changeFingerprint: guide.changeFingerprint,
      })
      return { ...generated, guide, persisted: true }
    } catch (error) {
      if (this.isCurrent(job)) this.update(job, { status: 'failed', step: undefined, error: errorMessage(error) })
      return null
    }
  }
}

function cachedStatus(ctx: IpcContext, target: PrGuideTarget, guide: ReviewGuide | null): ReviewGuideStatusEvent {
  return {
    repoRoot: ctx.session.gitContext?.repoRoot ?? projectScopeOf(ctx.session),
    key: prGuideKey(target), scope: 'pr', target, status: 'ready', headSha: target.headSha ?? '',
    baseSha: target.baseSha, updatedAt: Date.now(), generatedAt: guide?.generatedAt,
  }
}

function errorMessage(error: Parameters<typeof String>[0]): string {
  return error instanceof Error ? error.message : String(error)
}

export const prGuideJobs = new PrGuideJobs()
