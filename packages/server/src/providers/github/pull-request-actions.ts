import type {
  PrLifecycleAction,
  PrLifecycleUpdate,
  PrReviewerCandidate,
  PrReviewCapabilities,
  PrViewerPermissions,
  RepoRef,
} from '@solus/contracts/providers'
import type { GitHubClient } from './octokit'

type MutableLifecycleAction = Exclude<PrLifecycleAction, 'merge'>

interface RepositoryAccess {
  viewer: string
  author: string
  canWrite: boolean
  canTriage: boolean
  allowMergeCommit: boolean
  allowSquashMerge: boolean
  allowRebaseMerge: boolean
}

interface RepositorySettings {
  canWrite: boolean
  canTriage: boolean
  allowMergeCommit: boolean
  allowSquashMerge: boolean
  allowRebaseMerge: boolean
}

export interface PullRequestAccess {
  capabilities: PrReviewCapabilities
  viewerPermissions: PrViewerPermissions
}

const repositorySettingsByClient = new WeakMap<GitHubClient, Map<string, Promise<RepositorySettings>>>()

const MERGE_METHODS_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
    }
  }
`

interface MergeMethodsResponse {
  repository: {
    mergeCommitAllowed: boolean
    squashMergeAllowed: boolean
    rebaseMergeAllowed: boolean
  } | null
}

/**
 * Which merges the repository allows. REST's `allow_*_merge` fields are only
 * filled for an admin — every other viewer reads `null`, which used to become
 * "all three allowed" and offered a merge commit on a squash-only repository.
 * GraphQL answers the same question for anyone who can read the repository, so
 * it is the source here and REST is only the fallback for a host that refuses
 * the query.
 */
async function mergeMethodSettings(
  client: GitHubClient,
  repo: RepoRef,
  restFallback: { merge: boolean | null | undefined; squash: boolean | null | undefined; rebase: boolean | null | undefined },
): Promise<Pick<RepositorySettings, 'allowMergeCommit' | 'allowSquashMerge' | 'allowRebaseMerge'>> {
  try {
    const result = await client.graphql<MergeMethodsResponse>(MERGE_METHODS_QUERY, {
      owner: repo.owner,
      repo: repo.repo,
    })
    if (result.repository) {
      return {
        allowMergeCommit: result.repository.mergeCommitAllowed,
        allowSquashMerge: result.repository.squashMergeAllowed,
        allowRebaseMerge: result.repository.rebaseMergeAllowed,
      }
    }
  } catch {
    // Fall through: a pull request that cannot name its merge methods is still
    // worth showing, and the server re-checks the method before it merges.
  }
  return {
    allowMergeCommit: restFallback.merge ?? true,
    allowSquashMerge: restFallback.squash ?? true,
    allowRebaseMerge: restFallback.rebase ?? true,
  }
}

export async function githubPullRequestAccessFor(
  client: GitHubClient,
  repo: RepoRef,
  viewer: string,
  author: string,
): Promise<ReturnType<typeof githubPullRequestAccess>> {
  let cache = repositorySettingsByClient.get(client)
  if (!cache) {
    cache = new Map()
    repositorySettingsByClient.set(client, cache)
  }
  const key = `${repo.host}/${repo.owner}/${repo.repo}`
  let settings = cache.get(key)
  if (!settings) {
    settings = client.rest.repos.get({ owner: repo.owner, repo: repo.repo })
      .then(async ({ data }) => ({
        canWrite: !!(data.permissions?.push || data.permissions?.maintain || data.permissions?.admin),
        canTriage: !!data.permissions?.triage,
        ...(await mergeMethodSettings(client, repo, {
          merge: data.allow_merge_commit,
          squash: data.allow_squash_merge,
          rebase: data.allow_rebase_merge,
        })),
      }))
      .catch((error) => {
        cache?.delete(key)
        throw error
      })
    cache.set(key, settings)
  }
  return githubPullRequestAccess({ viewer, author, ...(await settings) })
}

export function githubPullRequestAccess(access: RepositoryAccess): PullRequestAccess {
  const isAuthor = access.viewer.toLowerCase() === access.author.toLowerCase()
  const lifecycle: PrLifecycleAction[] = access.canWrite || isAuthor
    ? ['close', 'reopen', 'ready', 'draft']
    : []
  if (access.canWrite) lifecycle.unshift('merge')

  const mergeMethods: PrReviewCapabilities['mergeMethods'] = []
  if (access.allowMergeCommit) mergeMethods.push('merge')
  if (access.allowSquashMerge) mergeMethods.push('squash')
  if (access.allowRebaseMerge) mergeMethods.push('rebase')

  return {
    capabilities: {
      diff: true,
      diffFileContents: true,
      inlineComments: true,
      threadReplies: true,
      threadResolution: true,
      reviewVerdicts: ['comment', 'approve', 'request-changes'],
      actions: ['merge', 'close', 'reopen', 'ready', 'draft'],
      mergeMethods,
      reviewerRequests: true,
      reviewerCandidates: true,
      labelManagement: true,
    },
    viewerPermissions: {
      actions: lifecycle,
      reviewVerdicts: isAuthor ? ['comment'] : ['comment', 'approve', 'request-changes'],
      comment: true,
      resolveThreads: true,
      requestReviewers: access.canWrite,
      manageLabels: access.canWrite || access.canTriage,
    },
  }
}

const READY_MUTATION = `
  mutation($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest { isDraft state updatedAt }
    }
  }
`

const DRAFT_MUTATION = `
  mutation($pullRequestId: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
      pullRequest { isDraft state updatedAt }
    }
  }
`

export async function updateGithubPullRequestLifecycle(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  action: MutableLifecycleAction,
  expectedHeadSha: string,
  pullRequest: { headSha: string; nodeId: string; draft: boolean },
): Promise<PrLifecycleUpdate> {
  if (pullRequest.headSha !== expectedHeadSha) {
    throw new Error('This pull request changed. Refresh it before changing its state.')
  }

  if (action === 'close' || action === 'reopen') {
    const { data } = await client.rest.pulls.update({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      state: action === 'close' ? 'closed' : 'open',
    })
    return {
      state: data.merged_at ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
      draft: data.draft ?? pullRequest.draft,
      updatedAt: data.updated_at,
    }
  }

  const result = await client.graphql<{
    markPullRequestReadyForReview?: { pullRequest: GithubLifecycleResult }
    convertPullRequestToDraft?: { pullRequest: GithubLifecycleResult }
  }>(action === 'ready' ? READY_MUTATION : DRAFT_MUTATION, {
    pullRequestId: pullRequest.nodeId,
  })
  const updated = action === 'ready'
    ? result.markPullRequestReadyForReview?.pullRequest
    : result.convertPullRequestToDraft?.pullRequest
  if (!updated) throw new Error('GitHub did not return the updated pull request state.')
  const state: PrLifecycleUpdate['state'] = updated.state === 'MERGED'
    ? 'merged'
    : updated.state === 'CLOSED' ? 'closed' : 'open'
  return {
    state,
    draft: updated.isDraft,
    updatedAt: updated.updatedAt,
  }
}

interface GithubLifecycleResult {
  isDraft: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  updatedAt: string
}

export async function listGithubReviewerCandidates(
  client: GitHubClient,
  repo: RepoRef,
  author: string,
): Promise<PrReviewerCandidate[]> {
  const collaborators = await client.rest.paginate(client.rest.repos.listCollaborators, {
    owner: repo.owner,
    repo: repo.repo,
    affiliation: 'all',
    per_page: 100,
  })
  return collaborators
    .filter((user) => user.login.toLowerCase() !== author.toLowerCase())
    .map((user) => ({ login: user.login, avatarUrl: user.avatar_url }))
}
