// Review guides, as this client sees them being made.
//
// Not a fact about a pull request, which is why this is not `PrsStore`: a guide
// is something *Solus* generated about one, on this machine. The code host has
// never heard of it. It is keyed by the local checkout and a stack-derived diff
// base, so two worktrees of one repository legitimately have different guides —
// which is also why the server does not hold it on its `PullRequest` entity.
//
// What lives here is the lifecycle of that generation: which pull requests are
// queued, which are being written, and whether a batch somebody explicitly
// asked for has finished.

import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { PullRequest } from '@solus/contracts/providers'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import type {
  PrGuideMetadata,
  PrGuideStatus,
  ReviewGuideStatusEvent,
} from '@solus/contracts/review'
import { detached, projectPrsKey } from './project-prs.svelte'
import type { PrsStore } from './prs.store.svelte'

/** How a batch somebody asked for finished. */
export interface GuideBatchOutcome {
  total: number
  failed: number
}

export class PrGuidesStore {
  /** Shared by the PRs page and the Activity tab, so both surfaces show one queue. */
  readonly status = new SvelteMap<string, PrGuideStatus>()
  readonly metadata = new SvelteMap<string, PrGuideMetadata>()

  /** The batch a person is waiting on, and how to tell them it is done. */
  private requestedNumbers = new Set<number>()
  private requestedContextKey = ''
  private onSettled: ((outcome: GuideBatchOutcome) => void) | null = null

  constructor(private readonly prs: PrsStore) {}

  statusFor(serverId: string, ctx: IpcContext, number: number): PrGuideStatus | undefined {
    return this.status.get(this.keyFor(serverId, ctx, number))
  }

  metadataFor(serverId: string, ctx: IpcContext, number: number): PrGuideMetadata | undefined {
    return this.metadata.get(this.keyFor(serverId, ctx, number))
  }

  /**
   * Read whether a guide exists for this pull request at this revision.
   *
   * The answer is dropped if the pull request moved while it was in flight: a
   * guide describes one revision, so "there is a guide" about the revision
   * before a push is not an answer about the one after it.
   */
  async loadMetadata(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    pr: Pick<PullRequest, 'number' | 'headSha'>,
  ): Promise<void> {
    const contextKey = projectPrsKey(serverId, ctx)
    const request = { number: pr.number, headSha: pr.headSha }
    const metadata = await api.prGuideMetadata(detached(ctx), request)
    if (this.prs.at(serverId, projectScopeOf(ctx.session))?.prFor(request.number)?.headSha !== request.headSha) return
    const key = `${contextKey}::${request.number}`
    const current = this.metadata.get(key)
    if (!metadata) {
      if (current) this.metadata.delete(key)
      return
    }
    // Compared before writing: an identical answer written back would notify
    // every row reading this map for nothing.
    if (
      current?.headSha === metadata.headSha
      && current.generatedAt === metadata.generatedAt
      && current.current === metadata.current
    ) return
    this.metadata.set(key, metadata)
  }

  /**
   * Queue generation for these pull requests — an explicit opt-in.
   *
   * Ones already queued or generating are skipped. Resolving means only
   * "queued"; completion arrives over the status subscription.
   */
  async request(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    numbers: number[],
    options: { onSettled?: (outcome: GuideBatchOutcome) => void } = {},
  ): Promise<void> {
    if (options.onSettled) {
      this.requestedContextKey = projectPrsKey(serverId, ctx)
      this.requestedNumbers = new Set(numbers)
      this.onSettled = options.onSettled
    }
    const targets = numbers.filter((number) => {
      const status = this.statusFor(serverId, ctx, number)
      return status !== 'queued' && status !== 'generating'
    })
    if (targets.length === 0) {
      this.settle()
      return
    }
    // Optimistic: the broadcast back confirms, or corrects, these.
    for (const number of targets) this.status.set(this.keyFor(serverId, ctx, number), 'queued')
    try {
      await api.prGenerateGuides(detached(ctx), targets)
    } catch (err) {
      if (options.onSettled) {
        this.requestedNumbers.clear()
        this.onSettled = null
      }
      for (const number of targets) {
        const key = this.keyFor(serverId, ctx, number)
        if (this.status.get(key) === 'queued') this.status.delete(key)
      }
      throw err
    }
  }

  /** Wired once, for the whole workspace. */
  subscribe(): () => void {
    const unsubscribePrGuides = subscribeAllHosts('pr.guideStatusChanged', (serverId, event) => {
      const contextKey = hostKey(serverId, event.repoRoot)
      const key = `${contextKey}::${event.number}`
      this.status.set(key, event.status)
      this.settle(contextKey)
      if (event.metadata) this.metadata.set(key, event.metadata)
    })
    // GitSection and the review surfaces generate through the general review
    // producer. A branch guide for the exact head of an open PR is still work
    // on that PR, so reflect its live lifecycle anywhere the PR is shown.
    const unsubscribeReviewGuides = subscribeAllHosts(
      'review.guideStatusChanged',
      (serverId, event) => this.applyReviewGuideStatus(serverId, event),
    )
    return () => {
      unsubscribePrGuides()
      unsubscribeReviewGuides()
    }
  }

  applyReviewGuideStatus(serverId: string, event: ReviewGuideStatusEvent): void {
    if (event.scope !== 'branch' && event.scope !== 'pr') return
    const project = this.prs.at(serverId, event.repoRoot)
    if (!project) return

    const pullRequests = event.target?.kind === 'pr'
      ? [project.prFor(event.target.number)].filter((pr) => pr?.headSha === event.headSha)
      : project.openPrs.filter((pr) => pr.headSha === event.headSha)

    for (const pr of pullRequests) {
      if (!pr) continue
      const key = `${hostKey(serverId, event.repoRoot)}::${pr.number}`
      if (event.status === 'queued' || event.status === 'generating' || event.status === 'failed') {
        this.status.set(key, event.status)
        continue
      }
      this.status.delete(key)
      if (event.status === 'ready') {
        void this.loadMetadata(project.hostApi, serverId, project.hostContext, pr).catch(() => {})
      }
    }
  }

  /** Tell the asker once every pull request in their batch has settled. */
  private settle(contextKey = this.requestedContextKey): void {
    if (contextKey !== this.requestedContextKey) return
    if (this.requestedNumbers.size === 0) return
    const statuses = [...this.requestedNumbers].map((number) => this.status.get(`${contextKey}::${number}`))
    if (statuses.some((status) => status !== 'ready' && status !== 'failed')) return

    const outcome: GuideBatchOutcome = {
      total: this.requestedNumbers.size,
      failed: statuses.filter((status) => status === 'failed').length,
    }
    const onSettled = this.onSettled
    this.requestedNumbers.clear()
    this.requestedContextKey = ''
    this.onSettled = null
    onSettled?.(outcome)
  }

  private keyFor(serverId: string, ctx: IpcContext, number: number): string {
    return `${projectPrsKey(serverId, ctx)}::${number}`
  }
}
