import type {
  PrLifecycleAction,
  PrLifecycleUpdate,
  PrReviewerCandidate,
  PrReviewCapabilities,
  PrViewerPermissions,
  RepoRef,
} from '../../../shared/providers'
import type { GitHubClient } from './octokit'

type MutableLifecycleAction = Exclude<PrLifecycleAction, 'merge'>

interface RepositoryAccess {
  viewer: string
  author: string
  canWrite: boolean
  allowMergeCommit: boolean
  allowSquashMerge: boolean
  allowRebaseMerge: boolean
}

interface RepositorySettings {
  canWrite: boolean
  allowMergeCommit: boolean
  allowSquashMerge: boolean
  allowRebaseMerge: boolean
}

const repositorySettingsByClient = new WeakMap<GitHubClient, Map<string, Promise<RepositorySettings>>>()

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
      .then(({ data }) => ({
        canWrite: !!(data.permissions?.push || data.permissions?.maintain || data.permissions?.admin),
        allowMergeCommit: data.allow_merge_commit ?? true,
        allowSquashMerge: data.allow_squash_merge ?? true,
        allowRebaseMerge: data.allow_rebase_merge ?? true,
      }))
      .catch((error) => {
        cache?.delete(key)
        throw error
      })
    cache.set(key, settings)
  }
  return githubPullRequestAccess({ viewer, author, ...(await settings) })
}

export function githubPullRequestAccess(access: RepositoryAccess): {
  capabilities: PrReviewCapabilities
  viewerPermissions: PrViewerPermissions
} {
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
    },
    viewerPermissions: {
      actions: lifecycle,
      reviewVerdicts: isAuthor ? ['comment'] : ['comment', 'approve', 'request-changes'],
      comment: true,
      resolveThreads: true,
      requestReviewers: access.canWrite,
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
      state: data.merged_at ? 'merged' : data.state as 'open' | 'closed',
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
  return {
    state: updated.state.toLowerCase() as PrLifecycleUpdate['state'],
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
  const { data: collaborators } = await client.rest.repos.listCollaborators({
    owner: repo.owner,
    repo: repo.repo,
    affiliation: 'all',
    per_page: 50,
  })
  return collaborators
    .filter((user) => user.login.toLowerCase() !== author.toLowerCase())
    .map((user) => ({ login: user.login, avatarUrl: user.avatar_url }))
}
