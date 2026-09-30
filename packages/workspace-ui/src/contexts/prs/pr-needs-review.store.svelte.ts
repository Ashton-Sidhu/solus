// The pull requests waiting on this viewer, per project.
//
// Its own store because it is its own question: not "what is in this project"
// but "what is being asked of me". A surface that shows the count asks PR sync
// to keep it fresh (`want`); the answer arrives with `pr.changed`. The host
// asks the code host every few minutes, and only while some surface wants it.

import type { HostApi } from '@solus/client-core/host-api'
import type { PullRequest } from '@solus/contracts/providers'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { projectPrsKey } from './project-prs.svelte'
import type { PrsStore } from './prs.store.svelte'

/** The part of a workspace that says which project it shows. */
interface ShowingWorkspace {
  readonly ctx: IpcContext
  serverIdForContext(ctx: IpcContext): string
  apiForContext(ctx: IpcContext): HostApi
}

export class PrNeedsReviewStore {
  /** Numbers by project. The pull requests themselves live in `PrsStore`. */
  private readonly byProject = new SvelteMap<string, number[]>()

  constructor(private readonly prs: PrsStore) {
    prs.onChange((change, projects) => {
      if (!change.needsReview) return
      for (const project of projects) this.byProject.set(project.key, change.needsReview)
    })
  }

  itemsFor(serverId: string, ctx: IpcContext): PullRequest[] {
    const project = this.prs.at(serverId, projectScopeOf(ctx.session))
    const numbers = this.byProject.get(projectPrsKey(serverId, ctx)) ?? []
    return numbers.flatMap((number) => {
      const pr = project?.prFor(number)
      return pr && pr.state === 'open' ? [pr] : []
    })
  }

  countFor(serverId: string, ctx: IpcContext): number {
    return this.itemsFor(serverId, ctx).length
  }

  /**
   * Keep the count of the project a workspace shows fresh, for a component
   * `$effect`. It depends on the project and host alone, so a tab switch
   * inside one project sends nothing.
   */
  wantShown(workspace: ShowingWorkspace): (() => void) | undefined {
    const ctx = workspace.ctx
    const serverId = workspace.serverIdForContext(ctx)
    if (!serverId || !projectScopeOf(ctx.session)) return
    return untrack(() => this.prs.want(workspace.apiForContext(ctx), serverId, ctx, [{ kind: 'needs-review' }]))
  }
}
