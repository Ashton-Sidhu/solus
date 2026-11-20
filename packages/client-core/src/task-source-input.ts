import type { TaskSource } from '@solus/contracts/task-sources'

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
// A GitHub login: letters, digits and single hyphens, 39 characters at most.
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/
/** The first path segment of a github.com URL that is not an account. */
const GITHUB_RESERVED_OWNERS = new Set(['orgs', 'users'])

/**
 * The source that a typed or pasted text names, or null.
 *
 * The choices that the host lists are the repositories the person pushed to
 * most recently and the Projects the connection can see. A person can also want another repository, or a
 * Project the list did not reach, so the setup takes:
 *
 * - `owner/repo`
 * - a repository URL: `https://github.com/owner/repo`
 * - a Project URL: `https://github.com/orgs/<owner>/projects/<n>` or
 *   `https://github.com/users/<owner>/projects/<n>`, with or without a view
 *
 * Tasks are read from github.com only, so a URL of another host is refused.
 * A URL of something inside a repository (an issue, a pull request, a file)
 * is refused too: it names one item, and a guess that the person meant the
 * whole repository would add a source they did not ask for. Nothing here
 * checks that the source exists; the host reports that after its first read.
 */
export function parseManualTaskSource(text: string): TaskSource | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const segments = githubPathSegments(trimmed)
  if (!segments) return null
  const [first, second] = segments
  if (GITHUB_RESERVED_OWNERS.has(first ?? '')) return projectSourceOf(segments)
  if (segments.length !== 2 || !first || !second) return null
  const repo = second.endsWith('.git') ? second.slice(0, -'.git'.length) : second
  if (!GITHUB_OWNER.test(first) || !GITHUB_REPO.test(repo) || repo === '.' || repo === '..')
    return null
  return { kind: 'github-repo', owner: first, repo }
}

/** `orgs/<owner>/projects/<n>` or `users/<owner>/projects/<n>`, then nothing
 *  or `views/<m>`. Another path under `orgs` or `users` is not a Project. */
function projectSourceOf(segments: readonly string[]): TaskSource | null {
  const [, owner, section, number, ...rest] = segments
  if (!owner || !GITHUB_OWNER.test(owner)) return null
  if (section !== 'projects' || !number || !/^[1-9]\d*$/.test(number)) return null
  if (rest.length !== 0 && !(rest.length === 2 && rest[0] === 'views')) return null
  const projectNumber = Number(number)
  if (!Number.isSafeInteger(projectNumber)) return null
  return { kind: 'github-project', owner, number: projectNumber }
}

/** The path segments of a github.com address, or of a bare `owner/repo`.
 *  Null for a text that names another host or is not an address. */
function githubPathSegments(text: string): string[] | null {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const firstSegment = text.split('/')[0] ?? ''
  // `github.com/owner/repo` without a scheme is still an address. A first
  // segment with a dot that is not GitHub is another host, not an owner.
  const looksLikeHost = !hasScheme && firstSegment.includes('.')
  if (!hasScheme && !looksLikeHost) return text.split('/').filter(Boolean)
  if (!URL.canParse(hasScheme ? text : `https://${text}`)) return null
  const url = new URL(hasScheme ? text : `https://${text}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port)
    return null
  return url.pathname.split('/').filter(Boolean)
}
