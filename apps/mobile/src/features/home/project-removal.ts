import type { HostApi } from '@solus/client-core/host-api'
import type { SolusProjectShell } from '../threads/thread-directory'
import { groupProjectScopes, type ProjectScope } from '../threads/new-task-project-selection'

/**
 * "Remove from projects" on the Home project filter, as desktop's
 * `ProjectsStore.removeProject`: every checkout of the project, on every
 * host, leaves its host's list (`untrackProject`). Nothing else is deleted:
 * sessions, tasks, and files stay. A host that is away, or that refuses,
 * keeps its checkout listed, and the person is told which.
 */

/** The project with its checkouts on every host, not only the host the filter shows. */
export function projectRemovalScope(projects: readonly SolusProjectShell[], projectKey: string): ProjectScope | null {
  return groupProjectScopes(projects).find((scope) => scope.key === projectKey) ?? null
}

export interface ProjectRemovalResult {
  /** The hosts that took a checkout off their list: their projects are read again. */
  readonly changedHostIds: readonly string[]
  /** One line for each checkout that stays listed. */
  readonly kept: readonly string[]
}

/** `apiFor` answers null for a host that is not connected now. */
export async function removeProjectCheckouts(
  checkouts: readonly SolusProjectShell[],
  apiFor: (hostId: string) => Pick<HostApi, 'untrackProject'> | null,
): Promise<ProjectRemovalResult> {
  const problems = await Promise.all(checkouts.map(async (checkout): Promise<string | null> => {
    const api = apiFor(checkout.hostId)
    if (!api) return `${checkout.hostLabel} is not connected.`
    return await api.untrackProject(checkout.project.path).then(
      () => null,
      (error: unknown) => `${checkout.hostLabel}: ${error instanceof Error && error.message.trim() ? error.message : 'the host did not remove it.'}`,
    )
  }))
  return {
    changedHostIds: [...new Set(checkouts.filter((_, index) => problems[index] === null).map((checkout) => checkout.hostId))],
    kept: problems.filter((problem): problem is string => problem !== null),
  }
}

export function projectRemovalPrompt(scope: ProjectScope): { readonly title: string; readonly message: string } {
  const hostLabels = [...new Set(scope.projects.map((project) => project.hostLabel))]
  const where = hostLabels.length === 1 ? hostLabels[0] : `${hostLabels.length} hosts (${hostLabels.join(', ')})`
  return {
    title: `Remove ${scope.title}?`,
    message: `This takes ${scope.title} off the project list on ${where}. Its sessions, tasks, and files stay. Open the folder again to list it again.`,
  }
}

/** Null when every checkout left its host's list. */
export function projectRemovalFailure(scope: ProjectScope, result: ProjectRemovalResult): { readonly title: string; readonly message: string } | null {
  if (result.kept.length === 0) return null
  return {
    title: `Could not remove ${scope.title}`,
    message: `${result.kept.join('\n')}\n\nThe project stays listed on ${result.kept.length === 1 ? 'that host' : 'those hosts'}.`,
  }
}
