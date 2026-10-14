import type { PrViewedFile, PrViewedFileChange, PrViewedFileState, PrViewedFiles, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from './octokit'

/**
 * GitHub's own record of which files the viewer marked viewed on a pull
 * request (`viewerViewedState`, `markFileAsViewed`, `unmarkFileAsViewed`).
 * Adapted from T3 Code (MIT, pingdotgg/t3code@e2e95a39d,
 * packages/source-control-github/src/server/gitHubPullRequestJson.ts).
 *
 * GitHub is the one record. It belongs to the GitHub account, so it agrees
 * with the github.com review page and with every client of every host that
 * signs in as that account. Solus keeps no copy.
 */

const FILES_PER_PAGE = 100
/** One read walks this many pages. More files than this is rare in a review. */
const MAX_PAGES = 10
/** Aliased mutations in one GraphQL document. */
const CHANGES_PER_MUTATION = 50

const VIEWED_FILES_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: ${FILES_PER_PAGE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { path viewerViewedState }
        }
      }
    }
  }
`

interface ViewedFilesResponse {
  repository: {
    pullRequest: {
      files: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: ({ path: string; viewerViewedState: string } | null)[] | null
      } | null
    } | null
  } | null
}

/** A state GitHub adds later reads as unviewed: it is the state that asks the least. */
function viewedStateOf(raw: string): PrViewedFileState {
  switch (raw.trim().toUpperCase()) {
    case 'VIEWED': return 'viewed'
    case 'DISMISSED': return 'dismissed'
    default: return 'unviewed'
  }
}

export async function readGithubViewedFiles(client: GitHubClient, repo: RepoRef, number: number): Promise<PrViewedFiles> {
  const files: PrViewedFile[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const response: ViewedFilesResponse = await client.graphql<ViewedFilesResponse>(VIEWED_FILES_QUERY, {
      owner: repo.owner,
      repo: repo.repo,
      number,
      after,
    })
    const pullRequest = response.repository?.pullRequest
    if (!pullRequest) throw new Error(`Pull request #${number} was not found in ${repo.owner}/${repo.repo}.`)
    for (const node of pullRequest.files?.nodes ?? []) {
      if (node?.path) files.push({ path: node.path, state: viewedStateOf(node.viewerViewedState) })
    }
    const pageInfo = pullRequest.files?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return { files, complete: true }
    after = pageInfo.endCursor
  }
  return { files, complete: false }
}

const PULL_REQUEST_ID_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
  }
`

/**
 * Mark and unmark files in as few requests as GitHub allows. GitHub has no
 * bulk form of the two mutations, so one document carries many aliased ones.
 * Only the last change to a path is sent.
 */
export async function writeGithubViewedFiles(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  changes: PrViewedFileChange[],
): Promise<void> {
  const latest = new Map<string, boolean>()
  for (const change of changes) {
    latest.delete(change.path)
    latest.set(change.path, change.viewed)
  }
  if (latest.size === 0) return
  const lookup = await client.graphql<{ repository: { pullRequest: { id: string } | null } | null }>(PULL_REQUEST_ID_QUERY, {
    owner: repo.owner,
    repo: repo.repo,
    number,
  })
  const pullRequestId = lookup.repository?.pullRequest?.id
  if (!pullRequestId) throw new Error(`Pull request #${number} was not found in ${repo.owner}/${repo.repo}.`)
  const entries = [...latest]
  for (let offset = 0; offset < entries.length; offset += CHANGES_PER_MUTATION) {
    const batch = entries.slice(offset, offset + CHANGES_PER_MUTATION)
    const variables = Object.fromEntries([['pullRequestId', pullRequestId], ...batch.map(([path], index) => [`p${index}`, path])])
    const declarations = ['$pullRequestId: ID!', ...batch.map((_, index) => `$p${index}: String!`)]
    const fields = batch.map(([, viewed], index) => {
      const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
      return `f${index}: ${mutation}(input: { pullRequestId: $pullRequestId, path: $p${index} }) { clientMutationId }`
    })
    await client.graphql(`mutation SetFilesViewed(${declarations.join(', ')}) {\n  ${fields.join('\n  ')}\n}`, variables)
  }
}
