import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'

/** What the pull request menu's link field says about its text. */
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
