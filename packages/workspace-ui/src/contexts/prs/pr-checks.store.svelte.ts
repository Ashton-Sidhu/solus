// CI status for a project's pull requests, and how hard the host should poll.
//
// Not `PrsStore`, because this is not something the client reads: the *server*
// polls, and this end reports what the user is looking at so the server can
// choose a cadence. What arrives is a whole repository's snapshot at once,
// which is why the checks live here keyed by project rather than on each
// pull request.

import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { detached, projectPrsKey } from './project-prs.svelte'

/** Where the client is looking, which is what the server sets its poll cadence
 *  from. Kept together so one report says all of it. */
interface WatchedScope {
  api: HostApi
  serverId: string
  ctx: IpcContext
}

export class PrChecksStore {
  private readonly byProject = new SvelteMap<string, PrChecksSnapshot>()
  /** Which repository each project's snapshot came from, so a broadcast about
   *  one repository reaches every checkout of it. */
  private readonly repoByProject = new Map<string, string>()

  summaryFor(serverId: string, ctx: IpcContext, number: number): PrChecksSummary | undefined {
    return this.byProject.get(projectPrsKey(serverId, ctx))?.checks
      .find((item) => item.number === number)?.summary
  }

  loadFailedFor(serverId: string, ctx: IpcContext): boolean {
    return this.byProject.get(projectPrsKey(serverId, ctx))?.loadFailed ?? false
  }

  /** Ask for the checks of the rows now on screen. */
  async load(api: HostApi, serverId: string, ctx: IpcContext, numbers: number[] = []): Promise<void> {
    const safeCtx = detached(ctx)
    this.apply(serverId, await api.prChecks(safeCtx, numbers), projectPrsKey(serverId, ctx))
  }

  /**
   * Follow the host's polling. Wired once, for the whole workspace.
   *
   * What is worth polling for is reported separately through `reportActivity`,
   * driven by the workspace's derived view of where the user is looking.
   */
  subscribe(watching: () => WatchedScope): () => void {
    const unsubscribe = subscribeAllHosts('pr.checksChanged', (serverId, snapshot) => this.apply(serverId, snapshot))
    return () => {
      unsubscribe()
      const scope = watching()
      // Say so on the way out, or the host keeps polling for a surface that is
      // no longer there.
      if (projectScopeOf(scope.ctx.session)) {
        void scope.api.prChecksActivity(detached(scope.ctx), false, false).catch(() => {})
      }
    }
  }

  /** Tell the host what the user is looking at, so it can set its poll cadence.
   *  A source with no project has nothing to poll for. */
  reportActivity(api: HostApi, ctx: IpcContext, reviewSurfaceOpen: boolean, active: boolean): void {
    if (!projectScopeOf(ctx.session)) return
    void api.prChecksActivity(detached(ctx), reviewSurfaceOpen, active).catch(() => {})
  }

  /** Forget one project's checks. */
  forget(serverId: string, projectScope: string): void {
    const key = hostKey(serverId, projectScope)
    this.byProject.delete(key)
    this.repoByProject.delete(key)
  }

  /**
   * File a snapshot.
   *
   * With a project named — this client asked — it lands there. Arriving by
   * broadcast it names only a repository, so it reaches **every checkout of
   * that repository on that host**: two worktrees of one repo see the same CI.
   */
  private apply(serverId: string, snapshot: PrChecksSnapshot, projectKey?: string): void {
    const repoKey = `${snapshot.repo.host}/${snapshot.repo.owner}/${snapshot.repo.repo}`
    if (projectKey) {
      this.repoByProject.set(projectKey, repoKey)
      this.byProject.set(projectKey, snapshot)
      return
    }
    const hostPrefix = hostKey(serverId, '')
    for (const [key, cachedRepoKey] of this.repoByProject) {
      if (!key.startsWith(hostPrefix) || cachedRepoKey !== repoKey) continue
      this.byProject.set(key, snapshot)
    }
  }
}
