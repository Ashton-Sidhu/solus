/**
 * Cross-project PR identity for the "All projects" scope. The list is the same
 * `prGroups` list either way; this file only supplies what it needs to stay
 * collision-safe once rows can come from more than one repository: every item,
 * action, and lookup keyed by `(serverId, projectRoot, number)` rather than a
 * bare number, since two repos can hand out the same PR number.
 */
import type { PullRequest } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { isRepositoryKey } from '@solus/contracts/repository-key'

export interface QualifiedProject {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
  items: PullRequest[]
}

/** One PR plus which project it came from — what an aggregate row's action
 *  (open, review, select) needs to route to the right host. */
export interface QualifiedPr {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
  pr: PullRequest
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
 *  `prGroups` hands back to `keyFor`), to the project a PR belongs to. */
export interface QualifiedProjectIndex {
  items: PullRequest[]
  byKey: Map<string, QualifiedPr>
  byPr: Map<PullRequest, QualifiedPr>
}

/** Flattens every project's items into one list, alongside the lookups above. */
export function flattenQualifiedProjects(projects: QualifiedProject[]): QualifiedProjectIndex {
  const items: PullRequest[] = []
  const byKey = new Map<string, QualifiedPr>()
  const byPr = new Map<PullRequest, QualifiedPr>()
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

export function qualifiedKeyOf(byPr: Map<PullRequest, QualifiedPr>): (pr: PullRequest) => string {
  return (pr) => {
    const qualified = byPr.get(pr)
    return qualified
      ? qualifiedPrKey(qualified.serverId, qualified.projectRoot, pr.number)
      : String(pr.number)
  }
}

/** How the page reaches a project: through a checkout whose host is online,
 *  or through the organization's workspace service. */
export interface PrProjectReach {
  /** The workspace service, when it is online to read through. */
  cloudServerId: string | null
  isOnlineCheckout: (serverId: string) => boolean
  apiFor: (serverId: string) => HostApi
  ctxFor: (projectRoot: string) => IpcContext
}

/**
 * The projects the every-project list reads, one per project. Only projects
 * reachable right now: a saved host that has never dialed keeps its request
 * queued in the transport with nothing to age it out, and one of those inside
 * the bounded worker pool blocks every project behind it. A project whose
 * checkouts are all off is read once per repository through the workspace
 * service, and one with neither is left out until a host connects.
 */
export function prProjectTargets(
  options: readonly { key: string; projectKey: string; serverId: string; label: string }[],
  reach: PrProjectReach,
): { serverId: string; projectRoot: string; label: string; api: HostApi; ctx: IpcContext }[] {
  return options.flatMap((option) => {
    if (reach.isOnlineCheckout(option.serverId)) {
      return [{
        serverId: option.serverId,
        projectRoot: option.projectKey,
        label: option.label,
        api: reach.apiFor(option.serverId),
        ctx: reach.ctxFor(option.projectKey),
      }]
    }
    if (!reach.cloudServerId || !isRepositoryKey(option.key)) return []
    return [{
      serverId: reach.cloudServerId,
      projectRoot: option.key,
      label: option.label,
      api: reach.apiFor(reach.cloudServerId),
      ctx: reach.ctxFor(option.key),
    }]
  })
}
