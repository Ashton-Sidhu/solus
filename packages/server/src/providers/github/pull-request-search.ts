import type { PrFilter, PrListPage, PullRequest, RepoRef } from '@solus/contracts/providers'
import { z } from 'zod'
import { createLogger } from '../../logger'
import type { PrPageRequest, RepositoryPage } from '../types'
import type { GitHubClient } from './octokit'
import {
  GITHUB_REPOSITORY_FACTS_FIELDS,
  rememberGithubRepositoryFacts,
  type GithubRepositoryFacts,
  type PullRequestAccess,
} from './pull-request-actions'
import { NEEDS_REVIEW_FIELDS, toNeedsReviewPullRequest, type GqlNeedsReviewPullRequest } from './pull-request-rows'

// ─── The pull request list ────────────────────────────────────────────────────
// One GitHub search over many repositories answers a page of all of them:
// `is:pr is:open repo:a repo:b … sort:updated-desc`, then the rows are split by
// repository. The viewer's own pull requests and the ones that ask for their
// review are three more searches over the same repositories, in the same
// document. A later page is the same search with `updated:<=` the last row the
// page before it held, so each repository keeps its own cursor and repositories
// at the same place share one search.
//
// Search can miss a repository: a renamed one is known to search only by its
// new name, and the index can lag a new pull request. Each repository's facts
// are read beside the search, and a repository search could not answer is read
// on its own through `repository.pullRequests`.

const log = createLogger('main', 'github-provider')

/** Rows per search and per listing page. GitHub's largest page. */
export const ROWS_PER_PAGE = 100
/** Repositories in one search. GitHub reads up to this many `repo:` qualifiers. */
const REPOSITORIES_PER_SEARCH = 100
/**
 * Connections of rows in one document. A connection of 100 rows asks for about
 * 30,000 nodes (labels, review requests, and assignees are 100 each), and
 * GitHub refuses a document past 500,000 nodes.
 */
const ROW_CONNECTIONS_PER_DOCUMENT = 8
/** Documents in flight at once. */
const PARALLEL_REQUESTS = 4

/** Where a repository's list continues. */
type Cursor =
  | { kind: 'first' }
  /** The next search page: rows updated at or before this time. */
  | { kind: 'search'; before: string }
  /** The next page of `repository.pullRequests`. */
  | { kind: 'list'; after: string }

function decodeCursor(cursor: string | null): Cursor {
  if (cursor === null) return { kind: 'first' }
  if (cursor.startsWith('search:')) return { kind: 'search', before: cursor.slice('search:'.length) }
  if (cursor.startsWith('list:')) return { kind: 'list', after: cursor.slice('list:'.length) }
  throw new Error('The pull request list cursor is not valid.')
}

/** How one repository is read: in a search of many, or on its own. */
type Strategy = 'search' | 'listing' | 'repository-search'

interface Target {
  index: number
  repo: RepoRef
  page: number
  cursor: Cursor
  strategy: Strategy
}

interface GqlRowConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: Array<GqlNeedsReviewPullRequest | null> | null
}

interface GqlRepository extends GithubRepositoryFacts {
  nameWithOwner: string
  pullRequests?: Partial<GqlRowConnection> & { totalCount?: number }
}

const answerSchema = z.record(z.string(), z.custom<GqlRepository | GqlRowConnection | null>())

/** GitHub's answer when some aliases failed: the others still carry data. */
const partialAnswerSchema = z.object({
  data: answerSchema,
  errors: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])).optional() })),
})

type Answer = z.infer<typeof answerSchema>

/** One alias's answer; empty where GitHub gave none. */
interface Slot {
  value?: GqlRepository | GqlRowConnection
}

/** The names search knows repositories by, learned from earlier answers. Keyed
 *  by the lowercase name a project uses. */
const searchNames = new Map<string, string>()

const slugOf = (repo: RepoRef): string => `${repo.owner}/${repo.repo}`

function searchSlugOf(repo: RepoRef): string {
  return searchNames.get(slugOf(repo).toLowerCase()) ?? slugOf(repo)
}

function stateQualifier(state: NonNullable<PrFilter['state']>): string {
  return state === 'open' ? 'is:open' : state === 'closed' ? 'is:closed' : ''
}

function statesLiteral(state: NonNullable<PrFilter['state']>): string {
  if (state === 'open') return '[OPEN]'
  if (state === 'closed') return '[CLOSED, MERGED]'
  return '[OPEN, CLOSED, MERGED]'
}

/** The search text for these repositories. The list's state, the reader's
 *  text, and its author narrow it; `extra` adds the priority qualifiers. */
export function pullRequestSearchQuery(
  slugs: string[],
  state: NonNullable<PrFilter['state']>,
  narrowing: { query?: string; author?: string; before?: string; extra?: string },
): string {
  return [
    'is:pr',
    stateQualifier(state),
    ...slugs.map((slug) => `repo:${slug}`),
    'sort:updated-desc',
    narrowing.before ? `updated:<=${narrowing.before}` : '',
    narrowing.author ? `author:${narrowing.author}` : '',
    narrowing.extra ?? '',
    narrowing.query?.trim() ?? '',
  ].filter(Boolean).join(' ')
}

/** One aliased field of a document. Every name and search text is a variable;
 *  only constants are written into the query. */
interface Part {
  field: (alias: string) => string
  variables: Array<{ name: string; type: string; value: string }>
}

const ROW_CONNECTION = `pageInfo { hasNextPage endCursor } nodes { ...NeedsReviewFields }`

function searchPart(query: string): Part {
  return {
    field: (alias) => `${alias}: search(query: $${alias}q, type: ISSUE, first: ${ROWS_PER_PAGE}) { ${ROW_CONNECTION} }`,
    variables: [{ name: 'q', type: 'String!', value: query }],
  }
}

function factsPart(repo: RepoRef, countStates: string | null): Part {
  const count = countStates ? `pullRequests(states: ${countStates}) { totalCount }` : ''
  return {
    field: (alias) => `${alias}: repository(owner: $${alias}o, name: $${alias}n) {
      nameWithOwner ${GITHUB_REPOSITORY_FACTS_FIELDS} ${count}
    }`,
    variables: [{ name: 'o', type: 'String!', value: repo.owner }, { name: 'n', type: 'String!', value: repo.repo }],
  }
}

function listingPart(repo: RepoRef, state: NonNullable<PrFilter['state']>, after: string | null, head: string | undefined): Part {
  const variables: Part['variables'] = [
    { name: 'o', type: 'String!', value: repo.owner },
    { name: 'n', type: 'String!', value: repo.repo },
  ]
  if (after) variables.push({ name: 'a', type: 'String', value: after })
  if (head) variables.push({ name: 'h', type: 'String', value: head })
  return {
    field: (alias) => `${alias}: repository(owner: $${alias}o, name: $${alias}n) {
      nameWithOwner ${GITHUB_REPOSITORY_FACTS_FIELDS}
      pullRequests(first: ${ROWS_PER_PAGE}, states: ${statesLiteral(state)}${after ? `, after: $${alias}a` : ''}${head ? `, headRefName: $${alias}h` : ''}, orderBy: { field: UPDATED_AT, direction: DESC }) {
        ${ROW_CONNECTION}
      }
    }`,
    variables,
  }
}

function documentOf(parts: Part[]) {
  const declarations: string[] = []
  const variables: { [name: string]: string } = {}
  const fields = parts.map((part, index) => {
    const alias = `p${index}`
    for (const variable of part.variables) {
      declarations.push(`$${alias}${variable.name}: ${variable.type}`)
      variables[`${alias}${variable.name}`] = variable.value
    }
    return part.field(alias)
  })
  return {
    query: `
      query PrListPages(${declarations.join(', ')}) {
        ${fields.join('\n')}
      }
      ${NEEDS_REVIEW_FIELDS}
    `,
    variables,
  }
}

/** The answer, or the part of it GitHub could give. An alias named by an
 *  error is dropped, so a failure there reads as "not answered". */
async function readAnswer(client: GitHubClient, parts: Part[]): Promise<Slot[]> {
  const { query, variables } = documentOf(parts)
  let answer: Answer
  try {
    answer = answerSchema.parse(await client.graphql(query, variables))
  } catch (error) {
    const partial = partialAnswerSchema.safeParse(error)
    if (!partial.success) throw error
    const failed = new Set(partial.data.errors.map((failure) => failure.path?.[0]))
    // An error with no alias is about the whole document.
    if (failed.has(undefined)) throw error
    answer = Object.fromEntries(Object.entries(partial.data.data).filter(([alias]) => !failed.has(alias)))
  }
  return parts.map((_part, index) => {
    const value = answer[`p${index}`]
    return value ? { value } : {}
  })
}

function repositoryOf(answer: Slot | undefined): GqlRepository | null {
  const value = answer?.value
  return value && 'nameWithOwner' in value ? value : null
}

function connectionOf(answer: Slot | undefined): GqlRowConnection | null {
  const value = answer?.value
  if (!value) return null
  if ('nameWithOwner' in value) {
    const rows = value.pullRequests
    return rows?.pageInfo ? { pageInfo: rows.pageInfo, nodes: rows.nodes ?? [] } : null
  }
  return value
}

/** Search can answer issues too; only a row with a number is a pull request. */
function pullRequestNodes(connection: GqlRowConnection): GqlNeedsReviewPullRequest[] {
  return (connection.nodes ?? []).flatMap((node) => node?.number ? [node] : [])
}

type AccessFor = (repo: RepoRef, author: string) => Promise<PullRequestAccess>

async function rowsFor(nodes: GqlNeedsReviewPullRequest[], repo: RepoRef, accessFor: AccessFor): Promise<PullRequest[]> {
  return Promise.all(nodes.map(async (node) => toNeedsReviewPullRequest(node, repo, await accessFor(repo, node.author?.login ?? ''))))
}

/** A unit of a document: the parts it adds, and how to read its answers. */
interface Block {
  parts: Part[]
  repositories: number
  connections: number
  settle: (answers: Slot[], outcome: RoundOutcome) => Promise<void>
}

interface RoundOutcome {
  pages: Map<number, RepositoryPage>
  /** Targets read again, on their own or with the names search knows. */
  retry: Target[]
}

interface Request {
  filter: PrFilter | undefined
  state: NonNullable<PrFilter['state']>
  viewer: string
  withPriority: boolean
  isRetry: boolean
}

function isUnsearched(filter: PrFilter | undefined): boolean {
  return !filter?.query?.trim() && !filter?.author && !filter?.head
}

/**
 * Many repositories at the same place, read by one search. On page one of an
 * unsearched list, the viewer's priority rows come with it.
 */
function searchBlock(targets: Target[], request: Request, client: GitHubClient, accessFor: AccessFor): Block {
  const cursor = targets[0].cursor
  const before = cursor.kind === 'search' ? cursor.before : undefined
  const isFirstUnsearched = cursor.kind === 'first' && isUnsearched(request.filter)
  const withPriority = request.withPriority && isFirstUnsearched
  const slugs = targets.map((target) => searchSlugOf(target.repo))
  const query = (state: NonNullable<PrFilter['state']>, extra?: string) => pullRequestSearchQuery(slugs, state, {
    query: extra ? undefined : request.filter?.query,
    author: extra ? undefined : request.filter?.author,
    before: extra ? undefined : before,
    extra,
  })
  // A review request only stands on an open pull request.
  const withReviewSearches = withPriority && request.state !== 'closed'
  const parts = [searchPart(query(request.state))]
  if (withPriority) parts.push(searchPart(query(request.state, `author:${request.viewer}`)))
  if (withReviewSearches) {
    parts.push(searchPart(query('open', `review-requested:${request.viewer}`)), searchPart(query('open', `assignee:${request.viewer}`)))
  }
  const priorityCount = parts.length
  // The count tells a repository search missed from one with nothing to show.
  const countStates = isFirstUnsearched ? statesLiteral(request.state) : null
  for (const target of targets) parts.push(factsPart(target.repo, countStates))

  return {
    parts,
    repositories: targets.length,
    connections: priorityCount,
    settle: async (answers, outcome) => {
      const facts = targets.map((_target, index) => repositoryOf(answers[priorityCount + index]))
      const rows = connectionOf(answers[0])
      // A repository search knew by another name: say the new one next time.
      let renamed = false
      const byRepository = new Map<string, number>()
      targets.forEach((target, index) => {
        const repository = facts[index]
        if (!repository) return
        rememberGithubRepositoryFacts(client, target.repo, repository)
        if (repository.nameWithOwner.toLowerCase() !== slugs[index].toLowerCase()) {
          searchNames.set(slugOf(target.repo).toLowerCase(), repository.nameWithOwner)
          renamed = true
        }
        byRepository.set(repository.nameWithOwner.toLowerCase(), index)
      })
      // A repository this credential cannot see has no facts and no page.
      const visible = targets.filter((_target, index) => facts[index])
      if (!rows) {
        // A search that named an old repository name fails whole. With the
        // names learned it can be asked again; otherwise each is read alone.
        for (const target of visible) {
          outcome.retry.push({ ...target, strategy: renamed && !request.isRetry ? 'search' : soloStrategy(target, request) })
        }
        return
      }
      const split = groupBy(pullRequestNodes(rows), byRepository)
      const splitAt = (index: number) => splitOf(connectionOf(answers[index]), byRepository)
      const authored = withPriority ? splitAt(1) : null
      const requested = withReviewSearches ? splitAt(2) : null
      const assigned = withReviewSearches ? splitAt(3) : null
      const nodes = pullRequestNodes(rows)
      const boundary = nodes.at(-1)?.updatedAt
      const hasMore = rows.pageInfo.hasNextPage && !!boundary

      await Promise.all(targets.map(async (target, index) => {
        const repository = facts[index]
        if (!repository) return
        const found = split.get(index) ?? []
        // Every match is in hand, yet fewer than the repository has: the
        // index has not caught up. Its own listing is current.
        const total = repository.pullRequests?.totalCount
        if (isFirstUnsearched && !rows.pageInfo.hasNextPage && total !== undefined && found.length < total && !request.isRetry) {
          outcome.retry.push({ ...target, strategy: 'listing' })
          return
        }
        const page: PrListPage = { items: await rowsFor(found, target.repo, accessFor), page: target.page, hasMore }
        if (hasMore) page.cursor = `search:${boundary}`
        const authoredPage: PrListPage | null = authored
          ? { items: await rowsFor(authored.groups.get(index) ?? [], target.repo, accessFor), page: 1, hasMore: authored.hasNextPage }
          : null
        const needsReview = await needsReviewOf(requested, assigned, index, target.repo, accessFor)
        outcome.pages.set(target.index, { page, authored: authoredPage, needsReview })
      }))
    },
  }
}

/** One search's rows by target index, and whether it had more. */
interface Split {
  hasNextPage: boolean
  groups: Map<number, GqlNeedsReviewPullRequest[]>
}

function splitOf(connection: GqlRowConnection | null, byRepository: Map<string, number>): Split | null {
  return connection
    ? { hasNextPage: connection.pageInfo.hasNextPage, groups: groupBy(pullRequestNodes(connection), byRepository) }
    : null
}

/** The review requests and assignments together, newest first, as
 *  `listPullRequestsNeedingReview` answers. Null when either is missing or has
 *  more rows than one page: that read pages to the end. */
async function needsReviewOf(
  requested: Split | null,
  assigned: Split | null,
  index: number,
  repo: RepoRef,
  accessFor: AccessFor,
): Promise<PullRequest[] | null> {
  if (!requested || !assigned || requested.hasNextPage || assigned.hasNextPage) return null
  const byNumber = new Map<number, PullRequest>()
  const both = [...requested.groups.get(index) ?? [], ...assigned.groups.get(index) ?? []]
  for (const row of await rowsFor(both, repo, accessFor)) byNumber.set(row.number, row)
  return [...byNumber.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** How a repository is read alone: its listing where the reader typed
 *  nothing, else a search of that repository by the name search knows. */
function soloStrategy(target: Target, request: Request): Strategy {
  if (request.filter?.head) return 'listing'
  if (target.cursor.kind === 'search' || !isUnsearched(request.filter)) return 'repository-search'
  return 'listing'
}

function groupBy(nodes: GqlNeedsReviewPullRequest[], byRepository: Map<string, number>): Map<number, GqlNeedsReviewPullRequest[]> {
  const groups = new Map<number, GqlNeedsReviewPullRequest[]>()
  for (const node of nodes) {
    const index = byRepository.get(node.baseRepository?.nameWithOwner.toLowerCase() ?? '')
    if (index === undefined) continue
    const group = groups.get(index) ?? []
    group.push(node)
    groups.set(index, group)
  }
  return groups
}

/** One repository's own listing: `repository.pullRequests`, newest first. */
function listingBlock(target: Target, request: Request, client: GitHubClient, accessFor: AccessFor): Block {
  const after = target.cursor.kind === 'list' ? target.cursor.after : null
  return {
    parts: [listingPart(target.repo, request.state, after, request.filter?.head)],
    repositories: 1,
    connections: 1,
    settle: async ([answer], outcome) => {
      const repository = repositoryOf(answer)
      const rows = connectionOf(answer)
      if (!repository || !rows) return
      rememberGithubRepositoryFacts(client, target.repo, repository)
      const page: PrListPage = {
        items: await rowsFor(pullRequestNodes(rows), target.repo, accessFor),
        page: target.page,
        hasMore: rows.pageInfo.hasNextPage && !!rows.pageInfo.endCursor,
      }
      if (page.hasMore) page.cursor = `list:${rows.pageInfo.endCursor}`
      outcome.pages.set(target.index, { page, authored: null, needsReview: null })
    },
  }
}

function blocksOf(targets: Target[], request: Request, client: GitHubClient, accessFor: AccessFor): Block[] {
  const blocks: Block[] = []
  const bySearchPlace = new Map<string, Target[]>()
  for (const target of targets) {
    if (target.strategy === 'listing') blocks.push(listingBlock(target, request, client, accessFor))
    // One repository searched alone, by the name search knows it by.
    else if (target.strategy === 'repository-search') blocks.push(searchBlock([target], { ...request, withPriority: false }, client, accessFor))
    else {
      // Repositories at the same place share one search.
      const place = target.cursor.kind === 'search' ? target.cursor.before : ''
      const group = bySearchPlace.get(place) ?? []
      group.push(target)
      bySearchPlace.set(place, group)
    }
  }
  for (const group of bySearchPlace.values()) {
    for (let start = 0; start < group.length; start += REPOSITORIES_PER_SEARCH) {
      blocks.push(searchBlock(group.slice(start, start + REPOSITORIES_PER_SEARCH), request, client, accessFor))
    }
  }
  return blocks
}

/** Blocks packed into documents, each inside GitHub's limits. */
function documentsOf(blocks: Block[]): Block[][] {
  const documents: Block[][] = []
  let current: Block[] = []
  let repositories = 0
  let connections = 0
  for (const block of blocks) {
    if (current.length > 0 && (repositories + block.repositories > REPOSITORIES_PER_SEARCH || connections + block.connections > ROW_CONNECTIONS_PER_DOCUMENT)) {
      documents.push(current)
      current = []
      repositories = 0
      connections = 0
    }
    current.push(block)
    repositories += block.repositories
    connections += block.connections
  }
  if (current.length > 0) documents.push(current)
  return documents
}

/** Read every document of one round. Throws only when every document failed,
 *  so the credential chain can try the next credential. */
async function readRound(targets: Target[], request: Request, client: GitHubClient, accessFor: AccessFor): Promise<RoundOutcome> {
  const outcome: RoundOutcome = { pages: new Map(), retry: [] }
  const documents = documentsOf(blocksOf(targets, request, client, accessFor))
  const failures: Array<{ blocks: Block[]; reason: unknown }> = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < documents.length) {
      const blocks = documents[next++]
      try {
        const answers = await readAnswer(client, blocks.flatMap((block) => block.parts))
        let offset = 0
        for (const block of blocks) {
          await block.settle(answers.slice(offset, offset + block.parts.length), outcome)
          offset += block.parts.length
        }
      } catch (reason) {
        failures.push({ blocks, reason })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, documents.length) }, worker))
  if (failures.length > 0 && failures.length === documents.length) throw failures[0].reason
  for (const { reason } of failures) {
    log.warn('github_pr_list_document_failed', { error: reason instanceof Error ? reason.message : String(reason) })
  }
  return outcome
}

/**
 * A page of each repository's pull requests, in the order asked, in as few
 * GraphQL documents as GitHub's limits allow. Null for a repository this
 * credential could not read; the caller reads that one alone.
 */
export async function readPullRequestPages(
  client: GitHubClient,
  requests: PrPageRequest[],
  filter: PrFilter | undefined,
  viewer: string,
  withPriority: boolean,
  accessFor: AccessFor,
): Promise<Array<RepositoryPage | null>> {
  const request: Request = { filter, state: filter?.state ?? 'open', viewer, withPriority, isRetry: false }
  const targets: Target[] = requests.map((entry, index) => {
    const cursor = decodeCursor(entry.cursor)
    const strategy: Strategy = filter?.head || cursor.kind === 'list' ? 'listing' : 'search'
    return { index, repo: entry.repo, page: entry.page, cursor, strategy }
  })
  const first = await readRound(targets, request, client, accessFor)
  const pages = first.pages
  if (first.retry.length > 0) {
    // A second round never throws: what the first answered stands.
    const second = await readRound(first.retry, { ...request, isRetry: true }, client, accessFor)
      .catch(() => ({ pages: new Map<number, RepositoryPage>() }))
    for (const [index, page] of second.pages) pages.set(index, page)
  }
  return targets.map((target) => pages.get(target.index) ?? null)
}
