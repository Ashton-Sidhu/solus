import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from './octokit'

/**
 * GitHub's search index knows a repository only by its current name. Every
 * other REST and GraphQL route follows a rename redirect, but `repo:<old-name>`
 * fails validation with "the listed users and repositories cannot be searched",
 * which reads as a missing repository or a missing permission. A checkout's
 * origin remote keeps the old name until someone re-points it, so a search has
 * to ask for the canonical name first.
 */
const canonicalSlugs = new Map<string, Promise<string>>()

/** The repository under the name GitHub holds today, for a search qualifier. */
export async function canonicalRepoRef(client: GitHubClient, repo: RepoRef): Promise<RepoRef> {
  const slug = `${repo.owner}/${repo.repo}`
  let resolving = canonicalSlugs.get(slug)
  if (!resolving) {
    resolving = client.rest.repos.get({ owner: repo.owner, repo: repo.repo })
      .then(({ data }) => data.full_name)
      // A lookup failure must not decide the search. It may be a rate limit or
      // a blip, and a genuinely inaccessible repository is reported by the
      // search itself rather than by this extra call.
      .catch(() => {
        canonicalSlugs.delete(slug)
        return slug
      })
    canonicalSlugs.set(slug, resolving)
  }
  const [owner, name, ...extra] = (await resolving).split('/')
  if (!owner || !name || extra.length) return repo
  return { ...repo, owner, repo: name }
}
