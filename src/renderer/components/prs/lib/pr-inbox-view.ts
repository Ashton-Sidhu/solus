/**
 * Qualifies pull requests for the workspace-wide inbox — every item, action,
 * and stack lookup is keyed by `(serverId, projectRoot, number)` rather than
 * a bare number, because two different repos can hand out the same PR
 * number. Reuses the single-project row grammar (`prGroups`/`prInboxGroups`
 * in `prs-list-view.ts`) unchanged: this file only supplies the qualified key
 * and the per-repo stack lookup those functions already accept.
 */
import type { PullRequestSummary } from '../../../../shared/providers'
import type { IpcContext } from '../../../../shared/types'
import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'
import type { StacksStore } from '../../../contexts/prs/stacks.store.svelte'

export interface QualifiedProject {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
  items: PullRequestSummary[]
}

/** One PR plus which project it came from — what an aggregate row's action
 *  (open, review, select) needs to route to the right host. */
export interface QualifiedPr {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
  pr: PullRequestSummary
}

export function qualifiedPrKey(serverId: string, projectRoot: string, number: number): string {
  return `${hostKey(serverId, projectRoot)}::${number}`
}

/** The `(api, serverId, ctx)` a row's action routes through. */
export interface PrTarget {
  api: HostApi
  serverId: string
  ctx: IpcContext
}

/** The union index `flattenQualifiedProjects` builds — one flat item list
 *  plus lookups from a row key, and from the `pr` object itself (what
 *  `prGroups`/`prInboxGroups` hand back to `keyFor`), to the project a PR
 *  belongs to. */
export interface QualifiedProjectIndex {
  items: PullRequestSummary[]
  byKey: Map<string, QualifiedPr>
  byPr: Map<PullRequestSummary, QualifiedPr>
}

/** Flattens every project's items into one list, alongside the lookups above. */
export function flattenQualifiedProjects(projects: QualifiedProject[]): QualifiedProjectIndex {
  const items: PullRequestSummary[] = []
  const byKey = new Map<string, QualifiedPr>()
  const byPr = new Map<PullRequestSummary, QualifiedPr>()
  for (const project of projects) {
    for (const pr of project.items) {
      const qualified: QualifiedPr = {
        serverId: project.serverId,
        projectRoot: project.projectRoot,
        label: project.label,
        api: project.api,
        ctx: project.ctx,
        pr,
      }
      items.push(pr)
      byKey.set(qualifiedPrKey(project.serverId, project.projectRoot, pr.number), qualified)
      byPr.set(pr, qualified)
    }
  }
  return { items, byKey, byPr }
}

/** Which PR a row is stacked on, read from that PR's own project's graph —
 *  never another project's, so a stack can never cross a repository. */
export function qualifiedStackParentOf(
  stacks: StacksStore,
  byPr: Map<PullRequestSummary, QualifiedPr>,
): (pr: PullRequestSummary) => number | null {
  return (pr) => {
    const qualified = byPr.get(pr)
    if (!qualified) return null
    return stacks.parentOf(pr.number, qualified.serverId, qualified.projectRoot)
  }
}

export function qualifiedKeyOf(byPr: Map<PullRequestSummary, QualifiedPr>): (pr: PullRequestSummary) => string {
  return (pr) => {
    const qualified = byPr.get(pr)
    return qualified
      ? qualifiedPrKey(qualified.serverId, qualified.projectRoot, pr.number)
      : String(pr.number)
  }
}
