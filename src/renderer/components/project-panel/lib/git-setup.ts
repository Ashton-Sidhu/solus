import type { GithubPublishRepositoryResult } from '../../../../shared/types'

/** A reasonable default repository name from the folder being published. */
export function repoNameFromCwd(cwd: string): string {
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? 'project'
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'project'
}

/** The stage that failed, in the order Publish runs them — for the retry label. */
export function publishFailureStage(result: GithubPublishRepositoryResult): 'repository' | 'remote' | 'push' | null {
  if (result.repository.status === 'failed') return 'repository'
  if (result.remote.status === 'failed') return 'remote'
  if (result.push.status === 'failed') return 'push'
  return null
}

/** The failed stage's own message, so the user sees git/GitHub's own words. */
export function publishFailureMessage(result: GithubPublishRepositoryResult): string | null {
  if (result.repository.status === 'failed') return result.repository.error
  if (result.remote.status === 'failed') return result.remote.error
  if (result.push.status === 'failed') return result.push.error
  return null
}

/** A GitHub URL to show once the repository exists, even if a later stage failed. */
export function publishRepositoryUrl(result: GithubPublishRepositoryResult): string | null {
  return result.repository.status === 'failed' ? null : result.repository.url
}
