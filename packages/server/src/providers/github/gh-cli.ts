// Reading pull requests through the `gh` CLI.
//
// The same pull requests as `provider.ts` reads, obtained the other way Solus
// can reach GitHub. Writes have had this second path since the beginning —
// `createPullRequest` and `resolvePullRequestUrl` both fall back here — while
// reads had none, so a host whose OAuth token was missing or expired answered
// every read with "GitHub is not connected" and every surface that names a pull
// request went blank. `gh` carries its own credential, so it answers when the
// adapter cannot.
//
// It is the same contract either way: this maps `gh`'s JSON onto `PullRequest`,
// the one shape both sides of the transport use. What it cannot know it reports
// as null — the contract's own word for "the host has not computed this" —
// rather than inventing a value.

import { homedir } from 'node:os'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type { PrFilter, PrListPage, PullRequest, RepoRef } from '@solus/contracts/providers'
import { z } from 'zod'
import { runAsync } from '../../git/exec'
import { buildChecksQuery, normalizeCliChecksResponse } from './checks'
import { githubPullRequestAccess, type PullRequestAccess } from './pull-request-actions'

/** `--repo` names the repository, so the CLI needs no checkout to run in — but
 *  `execFile` still needs a directory that exists. */
const ANY_DIRECTORY = homedir()

const CLI_TIMEOUT_MS = 15_000

/** Every field the mapper below reads. Requested as one list so `pr view` and
 *  `pr list` cannot drift into describing a pull request differently. */
const PR_FIELDS = [
  'number',
  'url',
  'title',
  'body',
  'state',
  'isDraft',
  'createdAt',
  'updatedAt',
  'author',
  'baseRefName',
  'baseRefOid',
  'headRefName',
  'headRefOid',
  'headRepository',
  'headRepositoryOwner',
  'isCrossRepository',
  'additions',
  'deletions',
  'changedFiles',
  'mergeable',
  'mergeStateStatus',
  'labels',
  'assignees',
  'reviewRequests',
].join(',')

const ghPullRequestSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  isDraft: z.boolean().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.object({ login: z.string().nullish(), is_bot: z.boolean().nullish() }).nullish(),
  baseRefName: z.string(),
  baseRefOid: z.string().nullish(),
  headRefName: z.string(),
  headRefOid: z.string().nullish(),
  headRepository: z.object({ name: z.string().nullish() }).nullish(),
  headRepositoryOwner: z.object({ login: z.string().nullish() }).nullish(),
  isCrossRepository: z.boolean().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  changedFiles: z.number().nullish(),
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  labels: z.array(z.object({ name: z.string(), color: z.string().nullish() })).nullish(),
  assignees: z.array(z.object({ login: z.string().nullish() })).nullish(),
  reviewRequests: z.array(z.object({ login: z.string().nullish() })).nullish(),
})

type GhPullRequest = z.infer<typeof ghPullRequestSchema>

const ghRepositorySchema = z.object({
  viewerPermission: z.string().nullish(),
  mergeCommitAllowed: z.boolean().nullish(),
  squashMergeAllowed: z.boolean().nullish(),
  rebaseMergeAllowed: z.boolean().nullish(),
})

const ghViewerSchema = z.object({ login: z.string() })

const ghComparisonSchema = z.object({
  merge_base_commit: z.object({ sha: z.string() }),
  commits: z.array(z.object({ sha: z.string() })),
})

/** GitHub's GraphQL mergeability is a word, and REST's is a boolean. The
 *  contract takes REST's, with null for "the host is still computing it". */
function mergeableOf(value: string | null | undefined): boolean | null {
  if (value === 'MERGEABLE') return true
  if (value === 'CONFLICTING') return false
  return null
}

function logins(users: Array<{ login?: string | null }> | null | undefined): string[] {
  return (users ?? []).flatMap((user) => (user.login ? [user.login] : []))
}

function toPullRequest(pr: GhPullRequest, repo: RepoRef, access: PullRequestAccess): PullRequest {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    // `gh` reports the head revision; the base revision is only present on some
    // queries, and an empty string is what the diff paths already treat as
    // "not known yet".
    headSha: pr.headRefOid ?? '',
    baseSha: pr.baseRefOid ?? '',
    baseRepo: repo,
    headRepo: {
      owner: pr.headRepositoryOwner?.login ?? repo.owner,
      repo: pr.headRepository?.name ?? repo.repo,
      isFork: pr.isCrossRepository ?? false,
    },
    author: pr.author?.login ?? '',
    // `gh` does not carry avatars. The surfaces fall back to initials.
    authorAvatarUrl: '',
    state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft ?? false,
    labels: (pr.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? '' })),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    requestedReviewers: logins(pr.reviewRequests),
    assignees: logins(pr.assignees),
    body: pr.body ?? '',
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    changedFiles: pr.changedFiles ?? null,
    mergeable: mergeableOf(pr.mergeable),
    // REST uses lower-case merge-state words. Keep the CLI path identical so
    // every conflict surface recognizes GitHub's `DIRTY` answer.
    mergeStateStatus: pr.mergeStateStatus?.toLowerCase() ?? null,
    ...access,
  }
}

function repoArg(repo: RepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`
}

async function gh(args: string[]): Promise<string> {
  return runAsync('gh', args, ANY_DIRECTORY, { timeout: CLI_TIMEOUT_MS })
}

/** The credential owned by `gh`, for git operations that cannot use the
 * provider adapter after its token is absent or rejected. */
export async function ghAuthToken(host: string): Promise<string> {
  return gh(['auth', 'token', '--hostname', host])
}

/**
 * What the `gh` credential may do in this repository, read once per repository
 * and then reused.
 *
 * The same rule the adapter applies, from the same function: whether a viewer
 * may merge, review or edit is a property of the repository and the account,
 * not of which transport asked.
 */
const accessByRepo = new Map<string, Promise<Omit<Parameters<typeof githubPullRequestAccess>[0], 'author'>>>()

async function repositoryAccess(
  repo: RepoRef,
): Promise<Omit<Parameters<typeof githubPullRequestAccess>[0], 'author'>> {
  const key = repoArg(repo)
  let pending = accessByRepo.get(key)
  if (!pending) {
    pending = (async () => {
      const [repository, viewer] = await Promise.all([
        gh(['repo', 'view', key, '--json', 'viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'])
          .then((raw) => ghRepositorySchema.parse(JSON.parse(raw))),
        gh(['api', 'user', '--jq', '{login: .login}'])
          .then((raw) => ghViewerSchema.parse(JSON.parse(raw)).login),
      ])
      const permission = repository.viewerPermission ?? ''
      return {
        viewer,
        canWrite: permission === 'WRITE' || permission === 'MAINTAIN' || permission === 'ADMIN',
        allowMergeCommit: repository.mergeCommitAllowed ?? true,
        allowSquashMerge: repository.squashMergeAllowed ?? true,
        allowRebaseMerge: repository.rebaseMergeAllowed ?? true,
      }
    })().catch((error) => {
      accessByRepo.delete(key)
      throw error
    })
    accessByRepo.set(key, pending)
  }
  return pending
}

async function accessFor(repo: RepoRef, author: string): Promise<PullRequestAccess> {
  return githubPullRequestAccess({ ...(await repositoryAccess(repo)), author })
}

/** One pull request, read through `gh`. */
export async function ghGetPullRequest(repo: RepoRef, number: number): Promise<PullRequest> {
  const raw = await gh(['pr', 'view', String(number), '--repo', repoArg(repo), '--json', PR_FIELDS])
  const pr = ghPullRequestSchema.parse(JSON.parse(raw))
  return toPullRequest(pr, repo, await accessFor(repo, pr.author?.login ?? ''))
}

/** Resolve the same merge base as the REST adapter through `gh`'s credential. */
export async function ghGetPullRequestDiffBase(
  repo: RepoRef,
  pullRequest: PullRequest,
): Promise<string> {
  const base = encodeURIComponent(pullRequest.baseSha)
  const head = encodeURIComponent(`${pullRequest.headRepo.owner}:${pullRequest.headRef}`)
  const raw = await gh([
    'api',
    '--hostname',
    repo.host,
    `repos/${repo.owner}/${repo.repo}/compare/${base}...${head}`,
  ])
  const comparison = ghComparisonSchema.parse(JSON.parse(raw))
  const comparedHeadSha = comparison.commits.at(-1)?.sha ?? comparison.merge_base_commit.sha
  if (comparedHeadSha !== pullRequest.headSha) {
    throw new Error('This pull request changed while its diff base was loading.')
  }
  return comparison.merge_base_commit.sha
}

/** Pull-request checks through the credential owned by `gh`.
 *
 * `gh pr checks` exposes the visible rows, but it does not expose whether each
 * row is required. The GraphQL command keeps that merge-gating fact by running
 * the same `statusCheckRollup` query as the connected adapter. */
export async function ghListChecks(
  repo: RepoRef,
  numbers: number[],
): Promise<NumberedPrChecksSummary[]> {
  const results: NumberedPrChecksSummary[] = []
  for (let offset = 0; offset < numbers.length; offset += 25) {
    const batch = numbers.slice(offset, offset + 25)
    const raw = await gh([
      'api',
      'graphql',
      '--hostname',
      repo.host,
      '-f',
      `query=${buildChecksQuery(batch)}`,
      '-F',
      `owner=${repo.owner}`,
      '-F',
      `repo=${repo.repo}`,
      '--jq',
      '[.data.repository[]]',
    ])
    results.push(...normalizeCliChecksResponse(raw, batch))
  }
  return results
}

/**
 * One page of a repository's pull requests, read through `gh`.
 *
 * `gh` has no page cursor, so a page is taken by reading up to its end and
 * slicing. That is affordable because this path only runs when the adapter
 * could not answer at all, and the pages a client asks for are small.
 */
export async function ghListPullRequestsPage(
  repo: RepoRef,
  filter?: PrFilter,
  page = 1,
  perPage = 100,
): Promise<PrListPage> {
  const args = [
    'pr',
    'list',
    '--repo',
    repoArg(repo),
    '--state',
    filter?.state ?? 'open',
    '--limit',
    String(page * perPage + 1),
    '--json',
    PR_FIELDS,
  ]
  if (filter?.head) args.push('--head', filter.head)
  if (filter?.author) args.push('--author', filter.author)

  const rows = z.array(ghPullRequestSchema).parse(JSON.parse(await gh(args)))
  // `gh` sorts by creation; the adapter and every surface below it read a list
  // ordered by most recent activity.
  rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const start = (page - 1) * perPage
  const wanted = rows.slice(start, start + perPage)
  const items = await Promise.all(
    wanted.map(async (pr) => toPullRequest(pr, repo, await accessFor(repo, pr.author?.login ?? ''))),
  )
  return { items, page, hasMore: rows.length > start + perPage }
}
