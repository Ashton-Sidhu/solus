// Pull requests, keyed by project.
//
// A map and nothing else. Every operation names a project first, because a pull
// request only means anything inside one:
//
//   prsStore.get(api, serverId, ctx).list()          // this project's rows
//   prsStore.get(api, serverId, ctx).get(7).merge()  // one pull request in it
//
// How the user is *looking* at them — which project is on screen, how the list
// was left — is not here; that is `PrView`.

import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { PrFilter } from '@solus/contracts/providers'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { ProjectPrs, projectPrsKey, type PrList } from './project-prs.svelte'

/** How many projects are read at once. Each is a host round trip that spends
 *  nearly all its time waiting, so the useful ceiling is well above the core
 *  count; four keeps a large workspace from opening a burst of requests. */
const DEFAULT_CONCURRENCY = 4

/** One project to read. Carries the handle needed to create its entry. */
export interface PrProject {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
}

export class PrsStore {
  private readonly byProject = new SvelteMap<string, ProjectPrs>()

  /** Bumped on every `listAll`; a project's write is dropped if the generation
   *  it began under is no longer current — the guard against a slow host
   *  landing after a newer refresh has begun. */
  private generation = 0

  /**
   * This project's pull requests, created on first mention.
   *
   * The caller's `api` and `ctx` are adopted on the way through: a review opened
   * from the project switcher reads against a different project than the tab it
   * sits in, and the caller is what knows which.
   */
  get(api: HostApi, serverId: string, ctx: IpcContext): ProjectPrs {
    const key = projectPrsKey(serverId, ctx)
    const existing = this.byProject.get(key)
    if (existing) {
      existing.reachThrough(api, ctx)
      return existing
    }
    const created = new ProjectPrs(api, serverId, ctx, projectScopeOf(ctx.session))
    this.byProject.set(key, created)
    return created
  }

  /**
   * The project at this key, or null.
   *
   * For surfaces that hold identity but no host handle — the git rail, a task
   * row — and so cannot create one. A null answer means "nothing has read this
   * project yet", which those surfaces render as absence.
   */
  at(serverId: string | null | undefined, projectScope: string | null | undefined): ProjectPrs | null {
    if (!serverId || !projectScope) return null
    return this.byProject.get(hostKey(serverId, projectScope)) ?? null
  }

  get all(): ProjectPrs[] {
    return [...this.byProject.values()]
  }

  /**
   * Read several projects at once, in parallel — the workspace-wide inbox.
   *
   * Each lands in its own entry through the same `list`, so a project already
   * open costs nothing. Projects not named here are dropped, except `keep` —
   * the page's own project, which must not lose its rows because the inbox
   * stopped naming it.
   */
  async listAll(
    targets: PrProject[],
    filter: PrFilter,
    opts: { force?: boolean; concurrency?: number; keep?: string } = {},
  ): Promise<void> {
    const generation = ++this.generation
    const named = new Set(targets.map((target) => projectPrsKey(target.serverId, target.ctx)))
    for (const key of this.byProject.keys()) {
      if (!named.has(key) && key !== opts.keep) this.byProject.delete(key)
    }
    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < targets.length) {
        const target = targets[index++]
        if (generation !== this.generation) return
        const project = this.get(target.api, target.serverId, target.ctx)
        // A project the host has already said has no git remote — a plain
        // folder — has nothing to list, and asking again on every refresh only
        // spends a worker slot a real repository could use. An explicit refresh
        // still retries it, so `git remote add` is one click from showing up.
        if (!opts.force && project.error?.kind === 'no-repository') continue
        const read: PrList = { filter }
        if (opts.force !== undefined) read.force = opts.force
        await project.list(read, () => generation === this.generation)
        if (generation !== this.generation) return
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  }

  /** A pull-request delta reaches the project holding it. Wired once, for the
   *  whole workspace so every mounted list and detail stays consistent. */
  subscribePullRequestChanges(): () => void {
    const unsubscribeLifecycle = subscribeAllHosts('pr.lifecycleChanged', (serverId, event) => {
      // Updated, never created: an event for a project nothing has opened has
      // nothing here to update, and inventing one would index a project the
      // user never asked about.
      this.at(serverId, event.projectRoot)?.applyPullRequest(event.detail)
    })
    const unsubscribeLabels = subscribeAllHosts('pr.labelsChanged', (serverId, event) => {
      this.at(serverId, event.projectRoot)?.applyLabels(event.number, event.labels)
    })
    return () => {
      unsubscribeLifecycle()
      unsubscribeLabels()
    }
  }
}

export { ProjectPrs, projectPrsKey, detached, type PrList, type PrQuery } from './project-prs.svelte'
