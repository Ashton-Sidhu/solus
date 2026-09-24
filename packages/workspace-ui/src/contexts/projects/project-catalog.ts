import { worktreeProjectRoot } from '@solus/contracts/types'
import { isRepositoryKey, localProjectKey } from '@solus/contracts/repository-key'
import type { WorkspaceProject } from '@solus/contracts/workspace-projects'
import { hostKey } from '@solus/client-core/host-key'
import type { ListProjectOption } from '../../components/ui/list-page/list-page'

/**
 * Canonical client-side project identity: a host and the repo root on it.
 * Equal paths on different hosts are distinct projects — never dedupe across
 * `serverId`.
 */
export interface ProjectRef {
  serverId: string
  projectRoot: string
}

/** The project authority shared by the four project-scoped pages
 * (docs/plans/project-model.md §5). A page owns this value while it is open,
 * and the tab in focus never sets it. `key` is the project — a repository key,
 * or a local-only folder's key — and filters every list. `checkout` is one
 * checkout of it, the place host-side facts (project configuration, a task
 * provider binding) are read from; null for a cloud project no known host
 * holds. */
export type ProjectPageScope =
  | { kind: 'all' }
  | { kind: 'project'; key: string; checkout: ProjectRef | null }

/** A checkout the catalog has recorded, with when it was last touched. */
export interface ProjectCatalogEntry extends ProjectRef {
  label: string
  lastSeenAt: number
  /** The repository the checkout belongs to, once its host has said; null for
   *  a folder with no hosted remote (docs/plans/project-model.md §1). */
  repositoryKey?: string | null
}

/**
 * One project as every page lists it (docs/plans/project-model.md): a
 * repository, with every checkout of it on any host, and its cloud record
 * when the organization has one. A folder with no remote is its own
 * local-only project, keyed by its host and path.
 */
export interface LogicalProject {
  /** The repository key, or `localProjectKey(serverId, path)` for a local-only folder. */
  key: string
  label: string
  cloudProject: WorkspaceProject | null
  checkouts: ProjectCatalogEntry[]
}

/** Group checkouts by the repository they hold, and join the organization's
 *  cloud projects — a cloud project with no checkout on any known host still
 *  lists. Most recently touched first; a cloud project nobody has touched on
 *  this device sorts after the ones someone has. */
export function groupLogicalProjects(
  checkouts: readonly ProjectCatalogEntry[],
  cloudProjects: readonly WorkspaceProject[],
): LogicalProject[] {
  const byKey = new Map<string, LogicalProject>()
  for (const cloudProject of cloudProjects) {
    byKey.set(cloudProject.repositoryKey, {
      key: cloudProject.repositoryKey,
      label: cloudProject.displayName,
      cloudProject,
      checkouts: [],
    })
  }
  for (const checkout of checkouts) {
    const key = logicalProjectKeyFor(checkout)
    const project = byKey.get(key)
    if (project) project.checkouts.push(checkout)
    else byKey.set(key, { key, label: checkout.label, cloudProject: null, checkouts: [checkout] })
  }
  const lastSeen = (project: LogicalProject) => Math.max(0, ...project.checkouts.map((checkout) => checkout.lastSeenAt))
  return [...byKey.values()].sort((a, b) => lastSeen(b) - lastSeen(a) || a.label.localeCompare(b.label))
}

/** The checkout host-side reads of a project go through: the most recently
 *  touched one on a connected host, else the most recent one, else none. */
export function representativeCheckout(
  project: Pick<LogicalProject, 'checkouts'>,
  isConnected: (serverId: string) => boolean,
): ProjectRef | null {
  const checkout = project.checkouts.find((entry) => isConnected(entry.serverId)) ?? project.checkouts[0]
  return checkout ? { serverId: checkout.serverId, projectRoot: checkout.projectRoot } : null
}

/** The scope a page takes when a person picks a project. */
export function scopeForProject(project: LogicalProject, isConnected: (serverId: string) => boolean): ProjectPageScope {
  return { kind: 'project', key: project.key, checkout: representativeCheckout(project, isConnected) }
}

/**
 * The project selector of every project page (docs/plans/project-model.md §5):
 * one row per project, never one per host. A project is available when a
 * connected host holds a checkout of it or the organization has it in the
 * cloud; the rest stay listed and inert. Two local-only folders with one name
 * on different hosts are told apart by their host.
 */
export function projectScopeOptions(
  projects: readonly LogicalProject[],
  isConnected: (serverId: string) => boolean,
  hostLabelFor: (serverId: string) => string,
  cloudServerId: string | null,
): ListProjectOption[] {
  const options = projects.flatMap((project): ListProjectOption[] => {
    const checkout = representativeCheckout(project, isConnected)
    const serverId = checkout?.serverId ?? (project.cloudProject ? cloudServerId : null)
    if (!serverId) return []
    return [{
      key: project.key,
      projectKey: checkout?.projectRoot ?? project.key,
      serverId,
      label: project.label,
      available: !!project.cloudProject || project.checkouts.some((entry) => isConnected(entry.serverId)),
      historyOnly: !project.cloudProject,
    }]
  })
  const labelCounts = new Map<string, number>()
  for (const option of options) labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1)
  for (const option of options) {
    if ((labelCounts.get(option.label) ?? 0) > 1 && !isRepositoryKey(option.key)) {
      option.label = `${option.label} · ${hostLabelFor(option.serverId)}`
    }
  }
  return options
}

/** The project a checkout belongs to: its repository, or itself when it has none. */
export function logicalProjectKeyFor(checkout: Pick<ProjectCatalogEntry, 'serverId' | 'projectRoot' | 'repositoryKey'>): string {
  return checkout.repositoryKey ?? localProjectKey(checkout.serverId, checkout.projectRoot)
}

/** Strips Solus worktree-marker segments and a trailing slash so a worktree
 *  checkout or a path typed with a trailing separator collapses to the same
 *  key as its project root. */
export function normalizeProjectRoot(path: string): string {
  const stripped = worktreeProjectRoot(path)
  return stripped.length > 1 ? stripped.replace(/\/+$/, '') : stripped
}

export function projectRefKey(ref: ProjectRef): string {
  return hostKey(ref.serverId, ref.projectRoot)
}
