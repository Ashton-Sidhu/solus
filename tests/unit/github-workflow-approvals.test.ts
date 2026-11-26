import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import {
  approveGithubWorkflowRuns,
  listGithubPendingWorkflowRuns,
  type WorkflowApprovalHead,
} from '@solus/server/providers/github/workflow-approvals'

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }
const head: WorkflowApprovalHead = {
  number: 12,
  headRef: 'patch-1',
  headSha: 'fork-sha',
  headRepo: { owner: 'newcomer', repo: 'app', isFork: true },
}

interface Sent { route: string; params: { [name: string]: string | number } }

function actionsGitHub(answers: {
  runs?: () => WorkflowRun[]
  openFromBranch?: () => OpenPullRequest[]
}): { client: GitHubClient; sent: Sent[] } {
  const sent: Sent[] = []
  const client = {
    rest: {
      request: async (route: string, params: Sent['params']) => {
        sent.push({ route, params })
        if (route === 'GET /repos/{owner}/{repo}/actions/runs') return { data: { workflow_runs: answers.runs?.() ?? [] } }
        if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: answers.openFromBranch?.() ?? [] }
        if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve') return { data: null }
        throw new Error(`unexpected request ${route}`)
      },
    },
    graphql: async () => ({}),
    credential: { source: 'host', token: 'test-token' },
  } as unknown as GitHubClient
  return { client, sent }
}

interface WorkflowRun {
  id: number
  name?: string
  html_url?: string | null
  head_sha: string
  head_branch?: string
  head_repository?: { full_name: string }
  pull_requests?: { number: number }[]
}

interface OpenPullRequest {
  number: number
  head: { sha: string; ref: string; repo: { full_name: string } }
}

const waiting: WorkflowRun[] = [
  { id: 301, name: 'CI', html_url: 'https://github.com/acme/app/actions/runs/301', head_sha: head.headSha, pull_requests: [{ number: 12 }] },
  { id: 302, name: ' ', html_url: null, head_sha: head.headSha, pull_requests: [{ number: 12 }] },
]
const openPullRequest = (target: WorkflowApprovalHead): OpenPullRequest => ({
  number: target.number,
  head: { sha: target.headSha, ref: target.headRef, repo: { full_name: `${target.headRepo.owner}/${target.headRepo.repo}` } },
})
const approvals = (sent: Sent[]) => sent.filter((request) => request.route.startsWith('POST ')).map((request) => request.params.run_id)
const sameRepositoryHead = { ...head, headRepo: { owner: repo.owner, repo: repo.repo, isFork: false } }

describe('workflow runs that wait for a maintainer', () => {
  test.each([head, sameRepositoryHead])('lists and approves the waiting runs associated with this pull request (%j)', async (target) => {
    const { client, sent } = actionsGitHub({
      runs: () => [
        ...waiting,
        { id: 303, name: 'Old', head_sha: 'older-sha' },
        { id: 304, name: 'Unrelated PR', head_sha: target.headSha, pull_requests: [{ number: 13 }] },
        { ...waiting[0], id: 305, head_repository: { full_name: 'other/app' } },
        { ...waiting[0], id: 306, head_branch: 'other-branch' },
      ],
      openFromBranch: () => [openPullRequest(target)],
    })

    expect(await listGithubPendingWorkflowRuns(client, repo, target)).toEqual([
      { id: 301, name: 'CI', url: 'https://github.com/acme/app/actions/runs/301' },
      { id: 302, name: 'Workflow run 302', url: null },
    ])
    expect(sent[0].params).toMatchObject({ head_sha: target.headSha, branch: target.headRef, event: 'pull_request', status: 'action_required' })

    expect(await approveGithubWorkflowRuns(client, repo, target)).toBe(2)
    expect(approvals(sent)).toEqual([301, 302])
    expect(sent.find((request) => request.route === 'GET /repos/{owner}/{repo}/pulls')?.params.head).toBe(`${target.headRepo.owner}:patch-1`)
  })

  test('keeps fork approval when GitHub provides no association and only this pull request has the head', async () => {
    const { client, sent } = actionsGitHub({
      runs: () => [{ ...waiting[0], pull_requests: [] }],
      openFromBranch: () => [openPullRequest(head)],
    })

    expect(await listGithubPendingWorkflowRuns(client, repo, head)).toHaveLength(1)
    expect(await approveGithubWorkflowRuns(client, repo, head)).toBe(1)
    expect(approvals(sent)).toEqual([301])
  })

  test('refuses the same-repository run when GitHub gives no pull request association', async () => {
    const { client, sent } = actionsGitHub({
      runs: () => [{ ...waiting[0], pull_requests: [] }],
      openFromBranch: () => [openPullRequest(sameRepositoryHead)],
    })

    await expect(listGithubPendingWorkflowRuns(client, repo, sameRepositoryHead)).rejects.toThrow('GitHub omitted workflow run pull request associations.')
    await expect(approveGithubWorkflowRuns(client, repo, sameRepositoryHead)).rejects.toThrow('GitHub omitted workflow run pull request associations.')
    expect(approvals(sent)).toEqual([])
  })

  test.each([head, sameRepositoryHead])('refuses approval when another open pull request shares the head (%j)', async (target) => {
    const { client, sent } = actionsGitHub({
      runs: () => waiting,
      openFromBranch: () => [openPullRequest(target), { ...openPullRequest(target), number: 13 }],
    })

    await expect(approveGithubWorkflowRuns(client, repo, target)).rejects.toThrow('Another open pull request has the same head commit')
    expect(approvals(sent)).toEqual([])
  })

  test('rechecks the current head before each approval', async () => {
    const open = openPullRequest(sameRepositoryHead)
    const { client, sent } = actionsGitHub({
      runs: () => waiting,
      openFromBranch: () => [approvals(sent).length ? { ...open, head: { ...open.head, sha: 'new-head' } } : open],
    })

    await expect(approveGithubWorkflowRuns(client, repo, sameRepositoryHead)).rejects.toThrow('This pull request changed.')
    expect(approvals(sent)).toEqual([301])
  })

  test('rechecks run association before each approval', async () => {
    const { client, sent } = actionsGitHub({
      runs: () => approvals(sent).length ? [{ ...waiting[1], pull_requests: [{ number: 13 }] }] : waiting,
      openFromBranch: () => [openPullRequest(sameRepositoryHead)],
    })

    expect(await approveGithubWorkflowRuns(client, repo, sameRepositoryHead)).toBe(1)
    expect(approvals(sent)).toEqual([301])
  })
})
