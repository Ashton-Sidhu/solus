import type { RepoRef } from '@solus/contracts/providers'
import { z } from 'zod'
import type { GitHubClient } from './octokit'

/**
 * The most of a `.diff` Solus takes in one answer. A larger change reads as
 * file pages instead, so no one response holds the whole of it.
 */
export const MAX_PULL_REQUEST_DIFF_BYTES = 8 * 1024 * 1024

/** GitHub refuses the diff media type with 406 past 300 files or its own size limit. */
const notAcceptableSchema = z.object({ status: z.literal(406) })

/** GitHub writes this line where it leaves a file's patch out. */
const OMITTED_PATCH = /^Binary files .+ differ$/m

export interface GithubPullRequestDiff {
  patch: string
  /** True when a file's patch is left out, so expanded context must come from
   *  the file contents read. */
  truncated: boolean
}

/**
 * The whole pull request diff in one request, as GitHub's `.diff` media type
 * gives it: complete file patches against the merge base.
 *
 * Null when GitHub refuses it (406) or it is larger than
 * `MAX_PULL_REQUEST_DIFF_BYTES`. The caller then reads the file pages.
 */
export async function readGithubPullRequestDiff(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
): Promise<GithubPullRequestDiff | null> {
  const response = await client.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
    mediaType: { format: 'diff' },
  }).catch((error) => {
    if (notAcceptableSchema.safeParse(error).success) return null
    throw error
  })
  if (!response) return null
  // Octokit types the body as the JSON pull request; the diff media type makes it text.
  const parsed = z.string().safeParse(response.data)
  if (!parsed.success) throw new Error('GitHub did not return the pull request diff as text.')
  const body = parsed.data
  if (Buffer.byteLength(body, 'utf8') > MAX_PULL_REQUEST_DIFF_BYTES) return null
  return { patch: body, truncated: OMITTED_PATCH.test(body) }
}
