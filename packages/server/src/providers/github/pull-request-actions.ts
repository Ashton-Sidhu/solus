import type {
  PrLifecycleAction,
  PrLifecycleUpdate,
  PrMergeMethod,
  PrRevertResult,
  PrReviewerCandidate,
  PrReviewCapabilities,
  PrStateAction,
  PrViewerPermissions,
  PullRequest,
  RepoRef,
} from '@solus/contracts/providers'
import { GitHubReauthRequiredError, type GitHubClient } from './octokit'

interface RepositoryAccess {
  viewer: string
  author: string
  canWrite: boolean
  canTriage: boolean
  allowMergeCommit: boolean
  allowSquashMerge: boolean
  allowRebaseMerge: boolean
  /** The repository has GitHub's auto-merge switched on. */
  allowAutoMerge: boolean
}

interface RepositorySettings {
  canWrite: boolean
  canTriage: boolean
  allowMergeCommit: boolean
  allowSquashMerge: boolean
  allowRebaseMerge: boolean
  allowAutoMerge: boolean
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
      autoMergeAllowed
    }
  }
`

interface MergeMethodsResponse {
  repository: {
    mergeCommitAllowed: boolean
    squashMergeAllowed: boolean
    rebaseMergeAllowed: boolean
    autoMergeAllowed: boolean
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
  restFallback: {
    merge: boolean | null | undefined
    squash: boolean | null | undefined
    rebase: boolean | null | undefined
    autoMerge: boolean | null | undefined
  },
): Promise<Pick<RepositorySettings, 'allowMergeCommit' | 'allowSquashMerge' | 'allowRebaseMerge' | 'allowAutoMerge'>> {
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
        allowAutoMerge: result.repository.autoMergeAllowed,
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
    // Unlike the merge methods, auto-merge is off unless a repository turns it
    // on, so an unknown answer does not offer a button the host would refuse.
    allowAutoMerge: restFallback.autoMerge ?? false,
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
          autoMerge: data.allow_auto_merge,
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
  // GitHub asks for write access to arm auto-merge or open a revert, the same
  // bar as the merge itself.
  if (access.canWrite && access.allowAutoMerge) lifecycle.push('enable-auto-merge', 'disable-auto-merge')
  if (access.canWrite) lifecycle.push('revert')
  const supported: PrLifecycleAction[] = ['merge', 'close', 'reopen', 'ready', 'draft']
  if (access.allowAutoMerge) supported.push('enable-auto-merge', 'disable-auto-merge')
  supported.push('revert')

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
      actions: supported,
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
  action: PrStateAction,
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

/** What an auto-merge mutation leaves on the pull request. */
export type PrAutoMergeUpdate = Pick<PullRequest, 'state' | 'draft' | 'updatedAt' | 'autoMergeEnabled' | 'autoMergeMethod'>

interface GithubAutoMergeResult extends GithubLifecycleResult {
  autoMergeRequest: { mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE' } | null
}

const AUTO_MERGE_RESULT_FIELDS = 'isDraft state updatedAt autoMergeRequest { mergeMethod }'

const ENABLE_AUTO_MERGE_MUTATION = `
  mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID) {
    enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }) {
      pullRequest { ${AUTO_MERGE_RESULT_FIELDS} }
    }
  }
`

const DISABLE_AUTO_MERGE_MUTATION = `
  mutation($pullRequestId: ID!) {
    disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
      pullRequest { ${AUTO_MERGE_RESULT_FIELDS} }
    }
  }
`

const REVERT_MUTATION = `
  mutation($pullRequestId: ID!) {
    revertPullRequest(input: { pullRequestId: $pullRequestId }) {
      revertPullRequest { number url }
    }
  }
`

const GITHUB_MERGE_METHOD = {
  merge: 'MERGE',
  squash: 'SQUASH',
  rebase: 'REBASE',
} as const satisfies { [Method in PrMergeMethod]: string }

/** GitHub's `auto_merge.merge_method` (REST) or `mergeMethod` (GraphQL). */
export function githubAutoMergeMethod(method: string | null | undefined): PrMergeMethod | undefined {
  const lower = method?.toLowerCase()
  return lower === 'merge' || lower === 'squash' || lower === 'rebase' ? lower : undefined
}

function autoMergeUpdate(updated: GithubAutoMergeResult | undefined): PrAutoMergeUpdate {
  if (!updated) throw new Error('GitHub did not return the updated pull request state.')
  const autoMergeMethod = githubAutoMergeMethod(updated.autoMergeRequest?.mergeMethod)
  return {
    state: updated.state === 'MERGED' ? 'merged' : updated.state === 'CLOSED' ? 'closed' : 'open',
    draft: updated.isDraft,
    updatedAt: updated.updatedAt,
    autoMergeEnabled: updated.autoMergeRequest !== null,
    // Always stated, so a disarm clears the method the read before it held.
    autoMergeMethod,
  }
}

/**
 * Arm auto-merge. The head the viewer saw rides along as `expectedHeadOid`, so
 * GitHub itself refuses to arm a merge of commits nobody looked at.
 */
export async function enableGithubAutoMerge(
  client: GitHubClient,
  pullRequestId: string,
  method: PrMergeMethod,
  expectedHeadSha: string,
): Promise<PrAutoMergeUpdate> {
  const result = await client.graphql<{ enablePullRequestAutoMerge?: { pullRequest: GithubAutoMergeResult } }>(
    ENABLE_AUTO_MERGE_MUTATION,
    { pullRequestId, mergeMethod: GITHUB_MERGE_METHOD[method], expectedHeadOid: expectedHeadSha },
  )
  return autoMergeUpdate(result.enablePullRequestAutoMerge?.pullRequest)
}

export async function disableGithubAutoMerge(
  client: GitHubClient,
  pullRequestId: string,
): Promise<PrAutoMergeUpdate> {
  const result = await client.graphql<{ disablePullRequestAutoMerge?: { pullRequest: GithubAutoMergeResult } }>(
    DISABLE_AUTO_MERGE_MUTATION,
    { pullRequestId },
  )
  return autoMergeUpdate(result.disablePullRequestAutoMerge?.pullRequest)
}

export async function revertGithubPullRequest(
  client: GitHubClient,
  pullRequestId: string,
): Promise<PrRevertResult> {
  const result = await client.graphql<{ revertPullRequest?: { revertPullRequest: PrRevertResult | null } }>(
    REVERT_MUTATION,
    { pullRequestId },
  )
  const opened = result.revertPullRequest?.revertPullRequest
  if (!opened) throw new Error('GitHub did not return the revert pull request.')
  return { number: opened.number, url: opened.url }
}

/**
 * Say a refused write as the thing that did not happen, then what to check.
 * GitHub's own reason stays in the middle: it is usually the answer. A lapsed
 * credential passes through unchanged, because its own error opens sign-in.
 */
export function githubWriteRefusal<E>(err: E, failure: string, hint: string): Error {
  if (err instanceof GitHubReauthRequiredError) return err
  const reason = err instanceof Error ? err.message.trim() : String(err)
  return new Error(`${failure}${reason ? `: ${reason.replace(/\.$/, '')}` : ''}. ${hint}`)
}

export const AUTO_MERGE_REFUSAL_HINT =
  'Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.'
