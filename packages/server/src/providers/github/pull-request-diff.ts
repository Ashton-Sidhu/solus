import type { RepoRef } from '@solus/contracts/providers'
import { z } from 'zod'
import type { GitHubClient } from './octokit'

/**
 * The most of a `.diff` Solus takes in one answer. A larger change reads as
 * file pages instead, so no one response holds the whole of it.
 */
export const MAX_PULL_REQUEST_DIFF_BYTES = 8 * 1024 * 1024
const MAX_WITHHELD_DIFF_BYTES = 32 * 1024 * 1024
const MAX_WITHHELD_LINE_LENGTH = 1_000

/** GitHub refuses the diff media type with 406 past 300 files or its own size limit. */
const notAcceptableSchema = z.object({ status: z.literal(406) })

/** GitHub writes this line where it leaves a file's patch out. */
const OMITTED_PATCH = /^Binary files .+ differ$/m

type GithubPullRequestDiff =
  | { status: 'loaded'; patch: string; truncated: boolean }
  | { status: 'too-large' }
  | { status: 'refused' }

/**
 * The whole pull request diff in one request, as GitHub's `.diff` media type
 * gives it: complete file patches against the merge base.
 *
 * The caller reads file pages if GitHub refuses the diff or the response is too large.
 */
export async function readGithubPullRequestDiff(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  withheld?: { commitSha?: string },
): Promise<GithubPullRequestDiff> {
  const target = {
    owner: repo.owner,
    repo: repo.repo,
    mediaType: { format: 'diff' },
  }
  const request = withheld?.commitSha
    ? client.rest.repos.getCommit({ ...target, ref: withheld.commitSha })
    : client.rest.pulls.get({ ...target, pull_number: number })
  const response = await request.catch((error) => {
    if (notAcceptableSchema.safeParse(error).success) return null
    throw error
  })
  if (!response) return { status: 'refused' }
  // Octokit types the body as the JSON pull request; the diff media type makes it text.
  const parsed = z.string().safeParse(response.data)
  if (!parsed.success) throw new Error('GitHub did not return the pull request diff as text.')
  const body = parsed.data
  if (Buffer.byteLength(body, 'utf8') > (withheld ? MAX_WITHHELD_DIFF_BYTES : MAX_PULL_REQUEST_DIFF_BYTES)) {
    return { status: 'too-large' }
  }
  return { status: 'loaded', patch: body, truncated: OMITTED_PATCH.test(body) }
}

/** Find the same file by its displayed path, then bound the lines sent to the client. */
export async function withheldGithubDiffPatch(patch: string, path: string): Promise<string | null> {
  const { parsePatchFiles } = await import('@pierre/diffs')
  const entry = 'diff --git '
  let start = patch.startsWith(entry) ? 0 : patch.indexOf(`\n${entry}`) + 1
  while (patch.startsWith(entry, start)) {
    const end = patch.indexOf(`\n${entry}`, start)
    const section = end === -1 ? patch.slice(start) : patch.slice(start, end)
    const hunk = section.indexOf('\n@@ ')
    if (hunk !== -1 && parsePatchFiles(section.slice(0, hunk))[0]?.files[0]?.name === path) {
      const lines = section.slice(hunk + 1).split('\n').map((line) => {
        if (!/^[ +\-]/.test(line) || line.length <= MAX_WITHHELD_LINE_LENGTH + 1) return line
        const cut = line.length - MAX_WITHHELD_LINE_LENGTH - 1
        return `${line.slice(0, MAX_WITHHELD_LINE_LENGTH + 1)} …[${cut.toLocaleString('en-US')} more characters]`
      })
      return `${section.slice(0, hunk)}\n${lines.join('\n')}`
    }
    if (end === -1) break
    start = end + 1
  }
  return null
}
