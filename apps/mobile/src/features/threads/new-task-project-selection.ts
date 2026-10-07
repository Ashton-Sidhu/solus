// Adapted from T3 Code apps/mobile/src/features/threads/new-task-project-selection.ts (MIT, see UPSTREAM.md).
import { distinctProjectLabels, groupByProject } from '@solus/client-core/project-identity'
import { isChat } from '@solus/contracts/chat'
import type { SolusProjectShell } from './thread-directory'

/**
 * T3 groups the same repository on several machines into one project "scope".
 * Solus uses the one project rule every client shares
 * (`@solus/client-core/project-identity`): a project is a repository with every
 * checkout of it on any host, and a folder with no hosted remote is a project
 * of its own. The new-task picker and the Home project filter both list these.
 */
export interface ProjectScope {
  /** The project key: the repository key, or `<hostId>:<path>` for a local-only folder. */
  readonly key: string
  /** The project's name, told apart from another scope in the same list that shares it. */
  readonly title: string
  readonly projects: readonly SolusProjectShell[]
  readonly representative: SolusProjectShell
  /** `SolusProjectShell.key` of every member. */
  readonly projectKeys: ReadonlySet<string>
}

/** Projects grouped by repository, in the order the directory lists them. Chat folders are not projects. */
export function groupProjectScopes(projects: readonly SolusProjectShell[]): ProjectScope[] {
  const groups = groupByProject(
    projects.filter((project) => !isChat(project.project.path)),
    (project) => ({ serverId: project.hostId, path: project.project.path, repositoryKey: project.project.repositoryKey }),
  )
  const hostLabels = new Map(projects.map((project) => [project.hostId, project.hostLabel]))
  const titles = distinctProjectLabels(
    groups.map((group) => ({ key: group.key, label: group.checkouts[0]!.project.folderName })),
    (hostId) => hostLabels.get(hostId) ?? hostId,
  )
  return groups.map((group, index) => ({
    key: group.key,
    title: titles[index]!,
    projects: group.checkouts,
    representative: group.checkouts[0]!,
    projectKeys: new Set(group.checkouts.map((project) => project.key)),
  }))
}

/** The project on the preferred host, else the scope's first. */
export function getProjectScopeSelectionTarget(scope: ProjectScope, preferredHostId: string | null): SolusProjectShell {
  return scope.projects.find((project) => project.hostId === preferredHostId) ?? scope.representative
}

export function filterProjectScopes(scopes: readonly ProjectScope[], searchText: string): readonly ProjectScope[] {
  const query = searchText.trim().toLowerCase()
  if (!query) return scopes
  return scopes.filter((scope) =>
    scope.title.toLowerCase().includes(query)
    || scope.projects.some((project) => project.project.folderName.toLowerCase().includes(query) || project.project.path.toLowerCase().includes(query)))
}

/** The same repository's checkouts on every host, for the draft's machine picker. */
export function scopeOfProject(scopes: readonly ProjectScope[], hostId: string, projectPath: string): ProjectScope | null {
  return scopes.find((scope) => scope.projects.some((project) => project.hostId === hostId && project.project.path === projectPath)) ?? null
}
