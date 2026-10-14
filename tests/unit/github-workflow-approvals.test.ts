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
  runs?: object[]
  openFromBranch?: object[]
}): { client: GitHubClient; sent: Sent[] } {
  const sent: Sent[] = []
  const client = {
    rest: {
      request: async (route: string, params: Sent['params']) => {
        sent.push({ route, params })
        if (route === 'GET /repos/{owner}/{repo}/actions/runs') return { data: { workflow_runs: answers.runs ?? [] } }
        if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: answers.openFromBranch ?? [] }
        if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve') return { data: null }
        throw new Error(`unexpected request ${route}`)
      },
    },
    graphql: async () => ({}),
    credential: { source: 'host', token: 'test-token' },
  } as unknown as GitHubClient
  return { client, sent }
}

const waiting = [
  { id: 301, name: 'CI', html_url: 'https://github.com/acme/app/actions/runs/301', head_sha: 'fork-sha' },
  { id: 302, name: ' ', html_url: null, head_sha: 'fork-sha' },
]
const approvals = (sent: Sent[]) => sent.filter((request) => request.route.startsWith('POST ')).map((request) => request.params.run_id)

describe('workflow runs that wait for a maintainer', () => {
  test('lists the waiting runs of exactly this head commit and fork branch', async () => {
    const { client, sent } = actionsGitHub({ runs: [...waiting, { id: 303, name: 'Old', head_sha: 'older-sha' }] })

    const runs = await listGithubPendingWorkflowRuns(client, repo, head)

    expect(runs).toEqual([
      { id: 301, name: 'CI', url: 'https://github.com/acme/app/actions/runs/301' },
      { id: 302, name: 'Workflow run 302', url: null },
    ])
    expect(sent[0].params).toMatchObject({ head_sha: 'fork-sha', branch: 'patch-1', event: 'pull_request', status: 'action_required' })
  })

  test('approves each waiting run when this pull request alone has the head commit', async () => {
    const { client, sent } = actionsGitHub({ runs: waiting, openFromBranch: [{ number: 12, head: { sha: 'fork-sha' } }] })

    expect(await approveGithubWorkflowRuns(client, repo, head)).toBe(2)
    expect(approvals(sent)).toEqual([301, 302])
    expect(sent.find((request) => request.route === 'GET /repos/{owner}/{repo}/pulls')?.params.head).toBe('newcomer:patch-1')
  })

  test('approves nothing when another open pull request shares the head commit', async () => {
    // WHY: GitHub links a fork's runs to no pull request. A second pull request
    // from the same fork branch at the same commit has the same runs, so an
    // approval here would also run untrusted code for that one.
    const { client, sent } = actionsGitHub({
      runs: waiting,
      openFromBranch: [{ number: 12, head: { sha: 'fork-sha' } }, { number: 13, head: { sha: 'fork-sha' } }],
    })

    await expect(approveGithubWorkflowRuns(client, repo, head)).rejects.toThrow(
      'Another open pull request has the same head commit, so Solus cannot tell which workflow runs belong to this one. Approve them on GitHub.',
    )
    expect(approvals(sent)).toEqual([])
  })
})
