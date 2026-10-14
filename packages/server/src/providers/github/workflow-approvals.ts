import { z } from 'zod'
import type { PrPendingWorkflowRun, PullRequest, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from './octokit'

/**
 * Workflow runs that GitHub holds until a maintainer approves them. GitHub
 * holds the `pull_request` runs of a fork, often only for a first-time
 * contributor, so the checks of such a pull request never start by themselves.
 * Adapted from T3 Code (MIT, pingdotgg/t3code@e2e95a39d,
 * packages/source-control-github/src/server/GitHubPullRequestApi.ts).
 */

/** The parts of a pull request that name its fork head. */
export type WorkflowApprovalHead = Pick<PullRequest, 'number' | 'headRef' | 'headSha' | 'headRepo'>

const RUNS_PER_PAGE = 100
/** More waiting runs than this is not a pull request a person reviews here. */
const MAX_RUN_PAGES = 10

const workflowRunsSchema = z.object({
  workflow_runs: z.array(z.object({
    id: z.number().int(),
    name: z.string().nullish(),
    html_url: z.string().nullish(),
    head_sha: z.string().nullish(),
  })),
})

const openPullRequestsSchema = z.array(z.object({
  number: z.number().int(),
  head: z.object({ sha: z.string() }),
}))

/**
 * The runs that wait for approval on the head commit of `head`. A run waiting
 * on a maintainer has `status=action_required`; `head_sha` scopes the runs to
 * this commit, and `branch` to the fork branch, as `gh run list` does.
 */
export async function listGithubPendingWorkflowRuns(
  client: GitHubClient,
  repo: RepoRef,
  head: WorkflowApprovalHead,
): Promise<PrPendingWorkflowRun[]> {
  const runs: PrPendingWorkflowRun[] = []
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
      if (run.head_sha && run.head_sha !== head.headSha) continue
      runs.push({ id: run.id, name: run.name?.trim() || `Workflow run ${run.id}`, url: run.html_url?.trim() || null })
    }
    if (parsed.data.workflow_runs.length < RUNS_PER_PAGE) return runs
  }
}

/**
 * Approve every run that waits on the head commit of `head`, one at a time.
 *
 * Runs are found by commit and branch name, not by pull request: GitHub gives
 * the runs of a fork no pull request link. When another open pull request
 * from the same fork branch has the same head commit, its runs are the same
 * runs, and an approval here would also approve them for that pull request.
 * Solus refuses that case and sends the person to GitHub.
 */
export async function approveGithubWorkflowRuns(
  client: GitHubClient,
  repo: RepoRef,
  head: WorkflowApprovalHead,
): Promise<number> {
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
  if (parsed.data.length >= 100 || sameHead.length !== 1 || sameHead[0].number !== head.number) {
    throw new Error('Another open pull request has the same head commit, so Solus cannot tell which workflow runs belong to this one. Approve them on GitHub.')
  }
  const runs = await listGithubPendingWorkflowRuns(client, repo, head)
  for (const run of runs) {
    await client.rest.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve', {
      owner: repo.owner,
      repo: repo.repo,
      run_id: run.id,
    })
  }
  return runs.length
}
