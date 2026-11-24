import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { repositoryKeyOf } from '@solus/contracts/repository-key'

/** A project option as the pull requests page lists it: keyed by its
 *  repository key, on the host of one of its checkouts. */
interface UrlProjectOption {
  key: string
  serverId: string
  available: boolean
}

/** A pasted pull request URL, and the project that reads it, if any. */
export interface PrUrlTarget<Option> {
  number: number
  url: string
  /** The repository key, `host/owner/name` in lowercase. */
  repository: string
  project: Option | null
}

/**
 * Where a pasted pull request URL is read. Its `owner/name` is its repository:
 * a project that is a reachable checkout of that repository reads it, as the
 * list does; with none, the repository itself does (`repositoryContext`).
 * Throws the message the URL field shows for a URL that is not a GitHub pull
 * request.
 */
export function prUrlTarget<Option extends UrlProjectOption>(
  address: string,
  options: readonly Option[],
  isReachable: (serverId: string) => boolean,
): PrUrlTarget<Option> {
  const parsed = parseGitHubPullRequestUrl(address)
  if (!parsed) throw new Error('Paste a GitHub pull request URL.')
  const repository = repositoryKeyOf(parsed.baseRepo)
  const project = options.find((option) => option.key === repository && option.available && isReachable(option.serverId)) ?? null
  return { number: parsed.number, url: parsed.url, repository, project }
}
