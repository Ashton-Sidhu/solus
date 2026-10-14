import { describe, expect, test } from 'bun:test'
import type { PrStackMergeRequest, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { githubPullRequestAccess } from '@solus/server/providers/github/pull-request-actions'
import { GithubStackMergeRefusal, mergeGithubPullRequestStack, type StackMergeClock } from '@solus/server/providers/github/stacks'

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

interface Layer {
  number: number
  state?: string
  merged_at?: string | null
  draft?: boolean
  head: { ref: string; sha?: string }
}

const threeLayers = (overrides: Partial<Layer>[] = []): Layer[] => [
  { number: 65, state: 'open', head: { ref: 'layer-1', sha: 'sha-65' } },
  { number: 66, state: 'open', head: { ref: 'layer-2', sha: 'sha-66' } },
  { number: 67, state: 'open', head: { ref: 'layer-3', sha: 'sha-67' } },
].map((layer, index) => ({ ...layer, ...overrides[index] }))

interface Sent { route: string; params: { [name: string]: string | number } }

/** A GitHub that holds one stack and answers merge-async with `answers` in turn. */
function stackGitHub(layers: Layer[], answers: object[]): { client: GitHubClient; sent: Sent[] } {
  const sent: Sent[] = []
  const stack = { number: 4, url: 'https://api.github.com/repos/acme/app/stacks/4', base: { ref: 'main' }, pull_requests: layers }
  const client = {
    rest: {
      request: async (route: string, params: Sent['params']) => {
        sent.push({ route, params })
        if (route === 'GET /repos/{owner}/{repo}/stacks') return { data: [stack] }
        if (route === 'GET /repos/{owner}/{repo}/stacks/{stack_number}') return { data: stack }
        if (route.includes('/merge-async')) {
          const answer = answers.shift()
          if (!answer) throw new Error(`no answer left for ${route}`)
          return { data: answer }
        }
        throw new Error(`unexpected request ${route}`)
      },
    },
    graphql: async () => ({}),
    credential: { source: 'host', token: 'test-token' },
  } as unknown as GitHubClient
  return { client, sent }
}

/** Time moves only when the merge waits, so a poll loop runs without real sleeps. */
function fakeClock(): StackMergeClock & { waits: number[] } {
  let now = 0
  const waits: number[] = []
  return { waits, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms } }
}

const mergeSecondLayer: PrStackMergeRequest = {
  number: 66,
  stackNumber: 4,
  method: 'squash',
  expectedHeads: [{ number: 65, headSha: 'sha-65' }, { number: 66, headSha: 'sha-66' }],
}

const merges = (sent: Sent[]) => sent.filter((request) => request.route.startsWith('PUT '))

describe('merging a GitHub stack', () => {
  test('lands the target and every open layer below it, with the head the viewer saw', async () => {
    const { client, sent } = stackGitHub(threeLayers(), [{ status: 'merged', details: {} }])

    const result = await mergeGithubPullRequestStack(client, repo, mergeSecondLayer, fakeClock())

    expect(result).toEqual({ status: 'merged', layers: [65, 66] })
    // WHY: GitHub checks `sha` itself, so a push to the target after Solus
    // read the stack still cannot land unseen commits.
    expect(merges(sent)).toEqual([{
      route: 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async',
      params: { owner: 'acme', repo: 'app', pull_number: 66, merge_method: 'squash', merge_action: 'default', sha: 'sha-66' },
    }])
  })

  test('follows a merge that GitHub runs in the background until it lands', async () => {
    const clock = fakeClock()
    const { client, sent } = stackGitHub(threeLayers(), [
      { status: 'pending', details: { uuid: 'job-1' } },
      { status: 'pending', details: { uuid: 'job-1' } },
      { status: 'enqueued', details: { uuid: 'job-1' } },
    ])

    const result = await mergeGithubPullRequestStack(client, repo, mergeSecondLayer, clock)

    expect(result.status).toBe('queued')
    expect(clock.waits).toEqual([1_000, 2_000])
    expect(sent.filter((request) => request.route.startsWith('GET /repos/{owner}/{repo}/pulls/')).map((request) => request.params.uuid)).toEqual(['job-1', 'job-1'])
  })

  test('says the merge still runs when GitHub has not finished by the deadline', async () => {
    const pending = Array.from({ length: 50 }, () => ({ status: 'pending', details: { uuid: 'job-1' } }))
    const { client } = stackGitHub(threeLayers(), pending)

    await expect(mergeGithubPullRequestStack(client, repo, mergeSecondLayer, fakeClock()))
      .rejects.toThrow('The stack merge still runs on GitHub. Check its status there before you try again.')
  })

  test('does not ask GitHub to merge when a lower layer moved since the viewer saw it', async () => {
    // WHY: a stack merge lands every lower layer, so a push to any of them
    // would land commits nobody reviewed. Only the target's head goes to GitHub.
    const { client, sent } = stackGitHub(threeLayers([{ head: { ref: 'layer-1', sha: 'pushed-later' } }]), [])

    await expect(mergeGithubPullRequestStack(client, repo, mergeSecondLayer, fakeClock()))
      .rejects.toThrow('The stack changed. Refresh it before you merge.')
    expect(merges(sent)).toEqual([])
  })

  test('refuses a stack that is not the one the viewer saw, or a layer list that is short', async () => {
    const { client, sent } = stackGitHub(threeLayers(), [])

    await expect(mergeGithubPullRequestStack(client, repo, { ...mergeSecondLayer, stackNumber: 5 }, fakeClock()))
      .rejects.toBeInstanceOf(GithubStackMergeRefusal)
    await expect(mergeGithubPullRequestStack(client, repo, { ...mergeSecondLayer, expectedHeads: [{ number: 66, headSha: 'sha-66' }] }, fakeClock()))
      .rejects.toThrow('The stack changed. Refresh it before you merge.')
    expect(merges(sent)).toEqual([])
  })

  test('skips layers that already merged, and stops at a draft layer', async () => {
    const mergedBottom = threeLayers([{ state: 'closed', merged_at: '2026-08-01T00:00:00Z' }])
    const { client } = stackGitHub(mergedBottom, [{ status: 'merged', details: {} }])
    const result = await mergeGithubPullRequestStack(client, repo, { ...mergeSecondLayer, expectedHeads: [{ number: 66, headSha: 'sha-66' }] }, fakeClock())
    expect(result.layers).toEqual([66])

    const draftBottom = stackGitHub(threeLayers([{ draft: true }]), [])
    await expect(mergeGithubPullRequestStack(draftBottom.client, repo, mergeSecondLayer, fakeClock()))
      .rejects.toThrow('A draft pull request is in the part of the stack to merge. Mark it ready for review, then merge.')
    expect(merges(draftBottom.sent)).toEqual([])
  })

  test('names GitHub\'s own reason when it refuses the merge', async () => {
    const { client } = stackGitHub(threeLayers(), [{ status: 'failed', details: { message: 'Required status check "ci" is failing.' } }])

    await expect(mergeGithubPullRequestStack(client, repo, mergeSecondLayer, fakeClock())).rejects.toThrow(
      'GitHub refused the stack merge: Required status check "ci" is failing. Check the branch rules and merge requirements of the stack.',
    )
  })
})

describe('who may merge a stack or approve workflow runs', () => {
  const access = (canWrite: boolean) => githubPullRequestAccess({
    viewer: 'viewer',
    author: 'author',
    canWrite,
    canTriage: false,
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: true,
    allowAutoMerge: false,
  })

  test('GitHub supports both for everyone, and grants them to a viewer who can write', () => {
    // WHY: a client hides an action the host lacks, and disables one the
    // viewer may not take. Both answers must come from the host.
    for (const canWrite of [true, false]) {
      expect(access(canWrite).capabilities.actions).toEqual(expect.arrayContaining(['merge-stack', 'approve-workflows']))
      expect(access(canWrite).capabilities.viewedFiles).toBe(true)
    }
    expect(access(true).viewerPermissions.actions).toEqual(expect.arrayContaining(['merge-stack', 'approve-workflows']))
    expect(access(false).viewerPermissions.actions).not.toContain('merge-stack')
    expect(access(false).viewerPermissions.actions).not.toContain('approve-workflows')
  })
})
