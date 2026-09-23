import type { ProviderRepository } from '@solus/contracts/providers'

/** How many repositories the project stage lists at once; search narrows the rest. */
export const REPOSITORY_ROWS = 6

export interface RepositoryRow {
  repositoryKey: string
  name: string
  detail: string
  /** Already a project of the organization in Solus Cloud. */
  isProject: boolean
}

/** A repository's key in the form project identity uses: `github.com/owner/repo`, lowercase. */
export function repositoryKeyOf(repository: ProviderRepository): string {
  return `${repository.host}/${repository.owner}/${repository.repo}`.toLowerCase()
}

/**
 * The rows of the project stage (docs/plans/cloud-onboarding.md §3.4): the
 * organization's projects first, then the account's repositories, most recently
 * pushed first, without the ones already listed as a project.
 */
export function repositoryRows(
  projects: readonly { repositoryKey: string; displayName: string }[],
  repositories: readonly ProviderRepository[],
  query: string,
): RepositoryRow[] {
  const needle = query.trim().toLowerCase()
  const matches = (key: string, name: string) => !needle || key.includes(needle) || name.toLowerCase().includes(needle)
  const projectKeys = new Set(projects.map((project) => project.repositoryKey))
  const projectRows: RepositoryRow[] = projects
    .filter((project) => matches(project.repositoryKey, project.displayName))
    .map((project) => ({
      repositoryKey: project.repositoryKey,
      name: project.displayName,
      detail: `${project.repositoryKey} · Already a project`,
      isProject: true,
    }))
  const repositoryRowsFound: RepositoryRow[] = [...repositories]
    .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
    .map((repository) => ({ repository, key: repositoryKeyOf(repository) }))
    .filter(({ key }) => !projectKeys.has(key))
    .filter(({ repository, key }) => matches(key, `${repository.owner}/${repository.repo}`))
    .map(({ repository, key }) => ({
      repositoryKey: key,
      name: `${repository.owner}/${repository.repo}`,
      detail: repository.isPrivate ? 'Private repository' : 'Public repository',
      isProject: false,
    }))
  return [...projectRows, ...repositoryRowsFound].slice(0, REPOSITORY_ROWS)
}
