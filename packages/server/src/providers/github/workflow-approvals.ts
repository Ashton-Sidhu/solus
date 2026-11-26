import { z } from 'zod'
import type { PrPendingWorkflowRun, PullRequest, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from './octokit'

/**
 * Workflow runs that GitHub holds until a maintainer approves them. This
 * can happen on fork and same-repository pull requests.
 * Adapted from T3 Code (MIT, pingdotgg/t3code@e2e95a39d,
 * packages/source-control-github/src/server/GitHubPullRequestApi.ts).
 */

export type WorkflowApprovalHead = Pick<PullRequest, 'number' | 'headRef' | 'headSha' | 'headRepo'>

const RUNS_PER_PAGE = 100
/** More waiting runs than this is not a pull request a person reviews here. */
const MAX_RUN_PAGES = 10

const workflowRunsSchema = z.object({
  workflow_runs: z.array(z.object({
    id: z.number().int(),
    name: z.string().nullish(),
    html_url: z.string().nullish(),
    head_sha: z.string(),
    head_branch: z.string().nullish(),
    head_repository: z.object({ full_name: z.string() }).nullish(),
    pull_requests: z.array(z.object({ number: z.number().int() })).nullish(),
  })),
})

const openPullRequestsSchema = z.array(z.object({
  number: z.number().int(),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
}))

/**
 * The runs that wait for approval on the head commit of `head`. A run waiting
 * on a maintainer has `status=action_required`; `head_sha` scopes the runs to
 * this commit, and `branch` to its branch.
 */
async function readWaitingRuns(
  client: GitHubClient,
  repo: RepoRef,
  head: WorkflowApprovalHead,
): Promise<PrPendingWorkflowRun[]> {
  const runs = new Map<number, PrPendingWorkflowRun>()
  const headRepository = `${head.headRepo.owner}/${head.headRepo.repo}`.toLowerCase()
  for (let page = 1; ; page++) {
    if (page > MAX_RUN_PAGES) throw new Error('GitHub has too many waiting workflow runs for this pull request. Approve them on GitHub.')
    const { data } = await client.rest.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner: repo.owner,
      repo: repo.repo,
      head_sha: head.headSha,
      branch: head.headRef,
      event: 'pull_request',
      status: 'action_required',
      per_page: RUNS_PER_PAGE,
      page,
    })
    const parsed = workflowRunsSchema.safeParse(data)
    if (!parsed.success) throw new Error('GitHub sent a workflow run list that Solus cannot read.')
    for (const run of parsed.data.workflow_runs) {
      if (run.head_sha !== head.headSha || (run.head_branch && run.head_branch !== head.headRef)) continue
      if (run.head_repository && run.head_repository.full_name.toLowerCase() !== headRepository) continue
      if (run.pull_requests?.length) {
        if (!run.pull_requests.some((pullRequest) => pullRequest.number === head.number)) continue
      } else if (!head.headRepo.isFork) {
        throw new Error('GitHub omitted workflow run pull request associations. Approve the runs on GitHub.')
      }
      runs.set(run.id, { id: run.id, name: run.name?.trim() || `Workflow run ${run.id}`, url: run.html_url?.trim() || null })
    }
    if (parsed.data.workflow_runs.length < RUNS_PER_PAGE) return [...runs.values()]
  }
}

/** A fork can have no explicit run association. A single open PR from that
 * owner and branch at this commit is the existing fallback. Check uniqueness
 * for both PR types and verify the head again before each approval. */
async function assertUniqueOpenHead(
  client: GitHubClient,
  repo: RepoRef,
  head: WorkflowApprovalHead,
): Promise<void> {
  const { data } = await client.rest.request('GET /repos/{owner}/{repo}/pulls', {
    owner: repo.owner,
    repo: repo.repo,
    state: 'open',
    head: `${head.headRepo.owner}:${head.headRef}`,
    per_page: 100,
  })
  const parsed = openPullRequestsSchema.safeParse(data)
  if (!parsed.success) throw new Error('GitHub sent a pull request list that Solus cannot read.')
  const sameHead = parsed.data.filter((pullRequest) => pullRequest.head.sha === head.headSha)
  if (parsed.data.length >= 100 || sameHead.length > 1) {
    throw new Error('Another open pull request has the same head commit, so Solus cannot tell which workflow runs belong to this one. Approve them on GitHub.')
  }
  const current = sameHead[0]
  if (
    current?.number !== head.number ||
    current.head.ref !== head.headRef ||
    current.head.repo?.full_name.toLowerCase() !== `${head.headRepo.owner}/${head.headRepo.repo}`.toLowerCase()
  ) {
    throw new Error('This pull request changed. Refresh it before you approve its workflow runs.')
  }
}

export async function listGithubPendingWorkflowRuns(
  client: GitHubClient,
  repo: RepoRef,
  head: WorkflowApprovalHead,
): Promise<PrPendingWorkflowRun[]> {
  const runs = await readWaitingRuns(client, repo, head)
  if (runs.length) await assertUniqueOpenHead(client, repo, head)
  return runs
}

export async function approveGithubWorkflowRuns(
  client: GitHubClient,
  repo: RepoRef,
  head: WorkflowApprovalHead,
): Promise<number> {
  const runs = await readWaitingRuns(client, repo, head)
  let approved = 0
  for (const run of runs) {
    // Another maintainer can approve a run, or GitHub can change its association.
    const pending = await readWaitingRuns(client, repo, head)
    await assertUniqueOpenHead(client, repo, head)
    if (!pending.some((candidate) => candidate.id === run.id)) continue
    await client.rest.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve', {
      owner: repo.owner,
      repo: repo.repo,
      run_id: run.id,
    })
    approved++
  }
  return approved
}
