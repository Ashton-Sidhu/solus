import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import type { TaskLinkInput } from '@solus/contracts/task-types'

/** What the link dialog says about the text in its field. */
export type PullRequestUrlCheck =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'valid'; url: string; label: string }

/** A pull request is linked by its page: the URL names the repository and the
 *  number, which a bare number cannot. */
export function checkPullRequestUrl(text: string): PullRequestUrlCheck {
  const value = text.trim()
  if (!value) return { kind: 'empty' }
  const parsed = parseGitHubPullRequestUrl(value)
  if (!parsed) return { kind: 'invalid' }
  return {
    kind: 'valid',
    url: parsed.url,
    label: `${parsed.baseRepo.owner}/${parsed.baseRepo.repo} #${parsed.number}`,
  }
}

/** The link a task makes to a pull request on the task itself. */
export function taskPullRequestLink(url: string): TaskLinkInput | null {
  const parsed = parseGitHubPullRequestUrl(url)
  if (!parsed) return null
  const { host, owner, repo } = parsed.baseRepo
  return {
    kind: 'pr',
    targetScope: `${host}/${owner}/${repo}`.toLowerCase(),
    targetKey: String(parsed.number),
    url: parsed.url,
  }
}
