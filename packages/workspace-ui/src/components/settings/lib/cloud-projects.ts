import type { WorkspaceProject } from '@solus/contracts/workspace-projects'
import type { ProjectCatalogEntry } from '../../../contexts/projects/project-catalog'

/**
 * The Settings view of the organization's projects (docs/plans/project-model.md
 * §2): what each cloud project's checkouts are, and which repositories this
 * device knows that are not cloud projects yet — the one-click adds.
 */

export interface CloudProjectSuggestion {
  repositoryKey: string
  label: string
}

/** Repositories this device has a checkout of that the organization does not
 *  have as a project, most recently touched first, each once. */
export function cloudProjectSuggestions(
  checkouts: readonly ProjectCatalogEntry[],
  cloudProjects: readonly WorkspaceProject[],
): CloudProjectSuggestion[] {
  const inCloud = new Set(cloudProjects.map((project) => project.repositoryKey))
  const seen = new Set<string>()
  const suggestions: CloudProjectSuggestion[] = []
  for (const checkout of [...checkouts].sort((a, b) => b.lastSeenAt - a.lastSeenAt)) {
    const key = checkout.repositoryKey
    if (!key || inCloud.has(key) || seen.has(key)) continue
    seen.add(key)
    suggestions.push({ repositoryKey: key, label: key.split('/').slice(1).join('/') })
  }
  return suggestions
}

/** The hosts holding a checkout of one cloud project, each host once. */
export function checkoutHostsOf(
  project: WorkspaceProject,
  checkouts: readonly ProjectCatalogEntry[],
): string[] {
  return [...new Set(checkouts.filter((checkout) => checkout.repositoryKey === project.repositoryKey).map((checkout) => checkout.serverId))]
}
