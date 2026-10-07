// CI status for a project's pull requests.
//
// A list reads the check runs of the rows it shows (`load`). An open review
// pane asks PR sync to keep its pull request's check runs fresh (`wantReview`),
// and what changes arrives with `pr.changed`. Keyed by project, because what
// arrives is a repository's answer.

import type { HostApi } from '@solus/client-core/host-api'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { NumberedPrChecksSummary, PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import type { IpcContext } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { detached, projectPrsKey, type ProjectPrs } from './project-prs.svelte'
import type { PrsStore } from './prs.store.svelte'

export class PrChecksStore {
  private readonly byProject = new SvelteMap<string, PrChecksSnapshot>()

  constructor(private readonly prs: PrsStore) {
    prs.onChange((change, projects) => {
      if (change.checks.length) this.merge(projects, change.checks)
    })
  }

  summaryFor(serverId: string, ctx: IpcContext, number: number): PrChecksSummary | undefined {
    return this.byProject.get(projectPrsKey(serverId, ctx))?.checks
      .find((item) => item.number === number)?.summary
  }

  /** This pull request's checks from any project of its repository, for a
   *  surface that holds identity but no host context — a sidebar row. */
  summaryIn(serverId: string, repositoryKey: string, number: number): PrChecksSummary | undefined {
    for (const project of this.prs.projectsReading(serverId, repositoryKey)) {
      const summary = this.byProject.get(project.key)?.checks.find((item) => item.number === number)?.summary
      if (summary) return summary
    }
    return undefined
  }

  loadFailedFor(serverId: string, ctx: IpcContext): boolean {
    return this.byProject.get(projectPrsKey(serverId, ctx))?.loadFailed ?? false
  }

  /** Ask for the checks of the rows now on screen. */
  async load(api: HostApi, serverId: string, ctx: IpcContext, numbers: number[]): Promise<void> {
    if (numbers.length === 0) return
    this.byProject.set(projectPrsKey(serverId, ctx), await api.prChecks(detached(ctx), numbers))
  }

  /** Keep one pull request's check runs fresh while a review pane shows it. */
  wantReview(api: HostApi, serverId: string, ctx: IpcContext, number: number): () => void {
    return this.prs.want(api, serverId, ctx, [{ kind: 'review', number }])
  }

  /** File changed check runs in every checkout of that repository: two
   *  worktrees of one repository see the same CI. */
  private merge(projects: ProjectPrs[], changed: NumberedPrChecksSummary[]): void {
    for (const project of projects) {
      const held = this.byProject.get(project.key)
      const numbers = new Set(changed.map(({ number }) => number))
      const checks = [...(held?.checks ?? []).filter(({ number }) => !numbers.has(number)), ...changed]
      const repo = held?.repo ?? project.prs.values().next().value?.baseRepo
      if (!repo) continue
      this.byProject.set(project.key, { repo, checks, loadFailed: false })
    }
  }
}
