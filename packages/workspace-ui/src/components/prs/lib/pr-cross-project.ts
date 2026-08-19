/**
 * Cross-project PR identity for the "All projects" scope — not the "My
 * inbox" view (`prInboxGroups`/`PrInboxActions` in `prs-list-view.ts`,
 * `prInboxFacts` in `pr-utils.ts`), which this does not touch or duplicate.
 * Both the global list and the inbox stay `prGroups`/`prInboxGroups`
 * unchanged; this file only supplies what they need to stay collision-safe
 * once rows can come from more than one repository: every item, action, and
 * stack lookup keyed by `(serverId, projectRoot, number)` rather than a bare
 * number, since two repos can hand out the same PR number.
 */
import type { PullRequestSummary } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
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
