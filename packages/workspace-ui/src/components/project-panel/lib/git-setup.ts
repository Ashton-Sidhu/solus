import type { GithubPublishRepositoryResult } from '@solus/contracts/types'

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
