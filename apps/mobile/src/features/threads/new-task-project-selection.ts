// Adapted from T3 Code apps/mobile/src/features/threads/new-task-project-selection.ts (MIT, see UPSTREAM.md).
import { isChat } from '@solus/contracts/chat'
import type { SolusProjectShell } from './thread-directory'

/**
 * T3 groups the same repository on several machines into one project "scope".
 * A Solus project names its repository by `repositoryKey`; a folder with no
 * hosted remote is a scope of its own.
 */
export interface ProjectScope {
  readonly key: string
  readonly title: string
  readonly projects: readonly SolusProjectShell[]
  readonly representative: SolusProjectShell
}

function scopeKey(project: SolusProjectShell): string {
  return project.project.repositoryKey ? `repo:${project.project.repositoryKey}` : `path:${project.hostId}\u0000${project.project.path}`
}

/** Projects grouped by repository, in the order the directory lists them. Chat folders are not projects. */
export function groupProjectScopes(projects: readonly SolusProjectShell[]): ProjectScope[] {
  const scopes = new Map<string, SolusProjectShell[]>()
  for (const project of projects) {
    if (isChat(project.project.path)) continue
    const key = scopeKey(project)
    const members = scopes.get(key)
    if (members) members.push(project)
    else scopes.set(key, [project])
  }
  return [...scopes].map(([key, members]) => ({
    key,
    title: members[0]!.project.folderName,
    projects: members,
    representative: members[0]!,
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
