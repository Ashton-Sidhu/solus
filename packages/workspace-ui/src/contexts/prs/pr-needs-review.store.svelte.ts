// The pull requests waiting on this viewer, per project.
//
// Its own store because it is its own question: not "what is in this project"
// but "what is being asked of me", answered by a different RPC on its own
// rhythm — a slow poll, plus a refresh when this client edits a pull request
// and when the user crosses into another project.
//
// Deliberately not on window focus. The count changes when someone else asks
// for a review, which bears no relation to when this window is looked at, so
// the listener re-asked once per app switch and learned nothing the poll would
// not have. The poll is the whole freshness story; there is no floor to keep
// because there is nothing firing often enough to need one.

import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { PullRequest } from '@solus/contracts/providers'
import { projectScopeOf, worktreeProjectRoot, type IpcContext } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { detached, projectPrsKey } from './project-prs.svelte'
import type { PrsStore } from './prs.store.svelte'

/** Slow on purpose: this is a background count, and the focus listener and the
 *  host's own invalidation are what make it feel current. */
const POLL_MS = 15 * 60_000

interface WatchedScope {
  api: HostApi
  serverId: string
  ctx: IpcContext
}

export class PrNeedsReviewStore {
  /**
   * Keyed by project, not a single list with a guard beside it.
   *
   * It used to be one flat array plus a "which project is this actually about"
   * field — the same shape that let one project's rows be read as another's.
   * Keying it removes the question.
   */
  private readonly byProject = new SvelteMap<string, PullRequest[]>()
  /** The read in flight per project, so two callers share one request. */
  private readonly inFlight = new Map<string, Promise<void>>()
  /** Bumped per project, so a slow answer cannot overwrite a newer one. */
  private readonly generation = new Map<string, number>()

  constructor(private readonly prs: PrsStore) {}

  itemsFor(serverId: string, ctx: IpcContext): PullRequest[] {
    return this.byProject.get(projectPrsKey(serverId, ctx)) ?? []
  }

  countFor(serverId: string, ctx: IpcContext): number {
    return this.itemsFor(serverId, ctx).length
  }

  async refresh(api: HostApi, serverId: string, ctx: IpcContext): Promise<void> {
    if (!projectScopeOf(ctx.session)) return
    const key = projectPrsKey(serverId, ctx)
    const running = this.inFlight.get(key)
    if (running) return running

    const seq = (this.generation.get(key) ?? 0) + 1
    this.generation.set(key, seq)
    const promise = api.prNeedsReview(detached(ctx))
      .then((items) => {
        if (this.generation.get(key) !== seq) return
        const project = this.prs.get(api, serverId, ctx)
        this.byProject.set(key, items.map((item) => project.absorb(item)))
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
      })
    this.inFlight.set(key, promise)
    return promise
  }

  /** Drop a pull request that is no longer waiting on anyone — merged, closed. */
  forget(serverId: string, projectScope: string, number: number): void {
    const items = this.byProject.get(hostKey(serverId, worktreeProjectRoot(projectScope)))
    if (!items) return
    const index = items.findIndex((item) => item.number === number)
    if (index >= 0) items.splice(index, 1)
  }

  /** Keep the count current: on a slow poll, and when this client edits a pull
   *  request in the project being shown. */
  subscribe(watching: () => WatchedScope): () => void {
    const releaseProjects = this.prs.subscribeLifecycleChanges()
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      const scope = watching()
      void this.refresh(scope.api, scope.serverId, scope.ctx).catch(() => {})
    }
    const unsubscribe = subscribeAllHosts('prs.invalidated', (serverId, { projectRoot }) => {
      const scope = watching()
      if (serverId === scope.serverId && projectRoot === projectScopeOf(scope.ctx.session)) refresh()
    })
    const interval = window.setInterval(refresh, POLL_MS)
    refresh()
    return () => {
      unsubscribe()
      releaseProjects()
      window.clearInterval(interval)
    }
  }
}
