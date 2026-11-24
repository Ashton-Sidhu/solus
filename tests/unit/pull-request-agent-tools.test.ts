import { expect, mock, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { CheckItem } from '@solus/contracts/checks-types'
import { CONFIGURABLE_SOLUS_TOOL_NAMES } from '@solus/contracts/agent-tools'
import { PullRequestHead } from '@solus/contracts/repository-key'
import { readSections } from '@solus/server/execution/agents/tools/pull-request-read'
import { selectChecks } from '@solus/server/providers/check-selection'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { mergeAgentPullRequest } from '@solus/server/providers/github/pull-request-actions'
import { claudeToolResponse } from '@solus/server/execution/agents/claude/claude-tool-adapter'
import { actionsJobId, readActionsCheckLog, rerunActionsChecks } from '@solus/server/providers/github/check-runs'
import { invalidateAgentPullRequestReads } from '@solus/server/providers/github/agent-pull-requests'
import type { CodeHost } from '@solus/server/prs/code-host'

import { DatabaseSync } from './helpers/bun-sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { pullRequestTools } = await import('@solus/server/execution/agents/tools/pull-request-tools')

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }
const headSha = 'head-seen-by-agent'
const check = (id: number, conclusion: CheckItem['conclusion'] = 'failure'): CheckItem => ({
  id: String(id), name: `job ${id}`, conclusion, inFlight: false, appName: 'GitHub Actions',
  detailsUrl: `https://github.com/acme/app/actions/runs/1/job/${id}`, startedAt: null, completedAt: null,
})

test('the configurable tool catalog has the nightly names and requires approval for writes', () => {
  const reads = ['pull_request_read', 'pull_request_list', 'ci_logs', 'list_thread_pull_requests']
  const writes = ['pull_request_create', 'pull_request_update', 'pull_request_respond', 'pull_request_review', 'pull_request_merge', 'ci_rerun']
  const tools = Object.values(pullRequestTools)
  expect(tools.map(tool => tool.name).sort()).toEqual([...reads, ...writes].sort())
  for (const tool of tools) {
    expect(CONFIGURABLE_SOLUS_TOOL_NAMES).toContain(tool.name)
    expect(tool.requiresApproval).toBe(writes.includes(tool.name))
  }
})

test('a tool call without an admitted session cannot read the code host', async () => {
  const result = await pullRequestTools.prRead.execute({ number: 42 }, {
    provider: 'codex',
    cwd: '/unused',
    sessionId: () => 'session',
    abortSignal: new AbortController().signal,
    parentToolUseId: () => undefined,
    emit: () => {},
  })
  expect(result).toEqual({ ok: false, text: 'This tool requires an active Solus session.' })
})

function compactFixture() {
  return {
    number: 42, url: 'https://github.com/acme/app/pull/42', title: 'Make the app ready',
    state: 'OPEN', isDraft: false, author: { login: 'dev' }, headRefName: 'feature', baseRefName: 'main',
    headRefOid: headSha, baseRefOid: 'base', mergeable: 'MERGEABLE', autoMergeRequest: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: 2, nodes: [
      { __typename: 'CheckRun', databaseId: 1, name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true,
        detailsUrl: 'https://github.com/acme/app/actions/runs/12/job/1', checkSuite: null },
      { __typename: 'CheckRun', databaseId: 2, name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: false,
        detailsUrl: 'https://github.com/acme/app/actions/runs/12/job/2', checkSuite: null },
    ] } } } }] },
    reviewThreads: { totalCount: 2, nodes: [{ isResolved: false }, { isResolved: true }] },
  }
}

function githubReadFixture(withThread = false, remarkSize = 0) {
  interface Request {
    query: string
    variables: { body?: boolean; threads?: boolean; comments?: boolean; reviews?: boolean; commentCursor?: string; first?: number; after?: string; query?: string }
  }
  const sent: Request[] = []
  const client = {
    credential: { source: 'host', token: 'test' },
    graphql: async (query: string, variables: Request['variables']) => {
      sent.push({ query, variables })
      if (query.includes('AgentLinkedPullRequests')) {
        const rows = new Map([...query.matchAll(/p(\d+): pullRequest/g)].map(([, pr]) => [
          `p${pr}`, { headRefName: `branch-${pr}`, baseRefName: 'main', headRepository: { nameWithOwner: 'acme/app' },
            stack: { number: 4, size: 3, baseRefName: 'main' }, stackEntry: { position: Number(pr) } },
        ]))
        return { r0: Object.fromEntries(rows) }
      }
      if (query.includes('AgentPullRequestNumberForHead')) return { repository: { pullRequests: { nodes: [
        { number: 49, state: 'OPEN', isCrossRepository: true, headRepository: { nameWithOwner: 'fork/app' } },
        { number: 43, state: 'CLOSED', isCrossRepository: false, headRepository: { nameWithOwner: 'acme/app' } },
        { number: 42, state: 'OPEN', isCrossRepository: false, headRepository: { nameWithOwner: 'acme/app' } },
      ] } } }
      const row = { ...compactFixture(), updatedAt: '2026-11-23T00:00:00Z', baseRepository: { nameWithOwner: 'acme/app' } }
      if (query.includes('AgentPullRequestList')) {
        return { repository: { pullRequests: { nodes: [row], pageInfo: { hasNextPage: !variables.after, endCursor: 'next-list' } } } }
      }
      if (query.includes('AgentPullRequestSearch')) {
        return { search: { nodes: [row, { ...row, number: 43 }], pageInfo: { hasNextPage: false, endCursor: null } } }
      }
      if (query.includes('AgentPullRequestActivity')) return { repository: { pullRequest: {
        id: 'PR_42',
        reviewThreads: withThread && variables.threads ? {
          nodes: [{
            id: 'thread', path: 'app.ts', line: 2, isResolved: false, isOutdated: false,
            comments: { nodes: [{ id: 'line-1', author: null, body: 'first', createdAt: '2026-11-23' }],
              pageInfo: { hasNextPage: true, endCursor: 'thread-next' } },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } : undefined,
        comments: variables.comments ? {
          nodes: [{ id: variables.commentCursor ?? 'A', author: null, body: 'comment' + 'x'.repeat(remarkSize),
            createdAt: variables.commentCursor ? '2026-11-22' : '2026-11-23' }],
          pageInfo: { hasNextPage: !variables.commentCursor, endCursor: 'B' },
        } : undefined,
      } } }
      if (query.includes('AgentPullRequestThreadComments')) return { node: { pullRequest: { id: 'PR_42' },
        comments: { nodes: [{ id: 'line-2', author: null, body: 'second', createdAt: '2026-11-23' }],
          pageInfo: { hasNextPage: false, endCursor: null } } } }
      return { repository: { pullRequest: { ...compactFixture(), body: variables.body ? '# Details' : undefined } } }
    },
  } as GitHubClient
  class TestProvider extends GitHubProvider {
    protected async clients() { return [client] }
  }
  const review = new TestProvider()
  const host = { repo, provider: { review } as CodeHost['provider'] }
  return { host, review, sent }
}

test('default read is one compact request, coalesces, and reuses only the same credential', async () => {
  const { host, sent } = githubReadFixture()
  const [first, repeated] = await Promise.all([readSections(host, 42, {}), readSections(host, 42, {})])
  expect(first).toEqual(repeated)
  expect(await readSections(host, 42, {})).toEqual(first)
  expect(Buffer.byteLength(JSON.stringify(first))).toBe(392)
  expect(sent).toHaveLength(1)
  expect(sent[0].query).toContain('commits(last: 1)')
  expect(sent[0].query).not.toMatch(/commits\(first|latestReviews|assignees/)
  expect(sent[0].variables).toMatchObject({ body: false, threads: true })
  expect(JSON.parse(JSON.stringify(first))).toEqual({
    host: 'github.com', repository: 'acme/app', number: 42, url: 'https://github.com/acme/app/pull/42',
    title: 'Make the app ready', state: 'open', isDraft: false, author: 'dev', headBranch: 'feature',
    baseBranch: 'main', headSha, mergeability: 'mergeable', behindBy: null, autoMergeEnabled: false,
    checks: { passed: 1, pending: 0, failed: ['unit'] }, unresolvedThreads: 1,
  })
  const other = githubReadFixture()
  await readSections(other.host, 42, {})
  expect(other.sent).toHaveLength(1)
  invalidateAgentPullRequestReads(repo)
  await readSections(host, 42, {})
  expect(sent).toHaveLength(2)
})

test('opt-in sections request only selected data and a cursor continues that section', async () => {
  const { host, sent } = githubReadFixture(false, 18_000)
  const first = await readSections(host, 42, { include: ['body', 'checks', 'comments'] })
  expect(sent.map(entry => entry.query.match(/query (\w+)/)?.[1])).toEqual(['AgentPullRequestSummary', 'AgentPullRequestActivity', 'AgentPullRequestActivity'])
  expect(sent[0].variables).toMatchObject({ body: true })
  expect(sent[1].variables).toMatchObject({ threads: true, comments: true, reviews: true })
  expect(first.body).toBe('# Details')
  expect(first.checkRuns?.map(check => check.name)).toEqual(['unit', 'lint'])
  expect(first.conversation?.reviewThreads).toBeUndefined()
  expect(first.conversation?.comments?.[0]?.kind).toBe('issue-comment')
  expect(first.conversation?.comments?.map(comment => comment.id)).toEqual(['B'])
  const next = await readSections(host, 42, { cursor: first.conversation!.nextCursor!, include: ['diff'] })
  expect(next.body).toBeUndefined()
  expect(next.conversation?.comments?.map(comment => comment.id)).toEqual(['A'])
  expect(sent).toHaveLength(3)
  expect(sent[2].variables).toMatchObject({ threads: false, comments: true, reviews: false, commentCursor: 'B' })
  await expect(readSections(host, 43, { cursor: first.conversation!.nextCursor! })).rejects.toThrow('from this pull request')
})

test('a branch read resolves the exact head before its summary without fetching viewer or PR detail', async () => {
  const { host, review, sent } = githubReadFixture()
  const head = new PullRequestHead(repo, 'feature')
  for (let read = 0; read < 2; read++) {
    const number = await review.agentPullRequestNumberForHead(repo, head, false)
    expect(number).toBe(42)
    await readSections(host, number!, {})
  }
  expect(sent.map(entry => entry.query.match(/query (\w+)/)?.[1])).toEqual(['AgentPullRequestNumberForHead', 'AgentPullRequestSummary'])
  expect(sent[0].query).not.toMatch(/viewer|commits|reviewThreads/)
  await review.agentPullRequestNumberForHead(repo, head, true)
  expect(sent).toHaveLength(3)
})

test('threads continue nested comments, while remarks alone use the first inline comment page', async () => {
  const { host, sent } = githubReadFixture(true)
  const result = await readSections(host, 42, { include: ['threads'] })
  expect(sent.map(entry => entry.query.match(/query (\w+)/)?.[1])).toEqual([
    'AgentPullRequestSummary', 'AgentPullRequestActivity', 'AgentPullRequestThreadComments',
  ])
  expect(result.conversation?.reviewThreads?.[0]).toMatchObject({
    comments: [{ body: 'first' }, { body: 'second' }], moreComments: false,
  })
  expect(result.conversation?.comments).toBeUndefined()
  const remarks = await readSections(host, 42, { include: ['comments'] })
  expect(sent).toHaveLength(5)
  expect(remarks.conversation?.comments).toContainEqual(expect.objectContaining({ kind: 'review-comment', path: 'app.ts', body: 'first' }))
  expect(remarks.conversation?.truncated).toBe(true)
})

test('list continues at the update boundary and skips a delivered row with the same time', async () => {
  const { review, sent } = githubReadFixture()
  const input = { state: 'open', involvement: 'all', limit: 1 } as const
  const first = await review.agentPullRequestList(repo, input)
  await review.agentPullRequestList(repo, input)
  const second = await review.agentPullRequestList(repo, { ...input, cursor: first.nextCursor! })
  expect(second.pullRequests.map(row => row.number)).toEqual([43])
  expect(second.nextCursor).toBeNull()
  expect(sent.map(entry => [entry.variables.first, entry.variables.after])).toEqual([[1, null], [2, null]])
  expect(sent[1].variables.query).toContain('updated:<=2026-11-23T00:00:00Z')
  expect(sent.every(entry => !entry.query.includes('viewer'))).toBe(true)
})

test('a list returns its useful first rows after a later server error, but permission failures stay errors', async () => {
  const row = { ...compactFixture(), updatedAt: '2026-11-23T00:00:00Z', baseRepository: { nameWithOwner: 'acme/app' } }
  let status = 503
  const client = { credential: { source: 'host', token: 'fixture' },
    graphql: async (_query: string, variables: { after: string | null }) => {
      if (variables.after) throw Object.assign(new Error('Provider refused the next page.'), { status })
      return { repository: { pullRequests: { nodes: [row], pageInfo: { hasNextPage: true, endCursor: 'more' } } } }
    },
  } as GitHubClient
  class TestProvider extends GitHubProvider {
    protected async clients() { return [client] }
  }
  const review = new TestProvider()
  const result = await review.agentPullRequestList(repo, { limit: 3, state: 'open', involvement: 'all' })
  expect(result.pullRequests.map(pr => pr.number)).toEqual([42])
  expect(result.nextCursor).not.toBeNull()
  status = 403
  await expect(review.agentPullRequestList(repo, { limit: 4, state: 'open', involvement: 'all' })).rejects.toThrow()
})

test('merge uses queue for a plain call, lands a ready auto call, and rejects a moved head', async () => {
  const sent: Array<{ operation: string; sha?: string }> = []
  const client = {
    graphql: async (query: string, variables: { expectedHeadOid?: string }) => {
      if (query.includes('AgentPullRequestMergePlan')) {
        sent.push({ operation: 'plan' })
        return { repository: { pullRequest: { id: 'p', headRefOid: headSha, mergeStateStatus: 'CLEAN', isMergeQueueEnabled: sent.length === 1 } } }
      }
      sent.push({ operation: 'queue', sha: variables.expectedHeadOid })
      return { enablePullRequestAutoMerge: { pullRequest: { state: 'OPEN', autoMergeRequest: { mergeMethod: 'SQUASH' } } } }
    },
    rest: { pulls: { merge: async ({ sha }: { sha: string }) => {
      sent.push({ operation: 'merge', sha })
      return { data: { merged: true } }
    } } },
  } as GitHubClient
  expect(await mergeAgentPullRequest(client, repo, { number: 42, headSha }, 'squash', false)).toBe('open')
  expect(await mergeAgentPullRequest(client, repo, { number: 42, headSha }, 'squash', true)).toBe('merged')
  await expect(mergeAgentPullRequest(client, repo, { number: 42, headSha: 'stale' }, 'squash', false)).rejects.toThrow('Review the new commits')
  expect(sent).toEqual([
    { operation: 'plan' }, { operation: 'queue', sha: headSha },
    { operation: 'plan' }, { operation: 'merge', sha: headSha }, { operation: 'plan' },
  ])
})

test('Claude receives structured PR results with the existing text fallback', () => {
  const text = '{"number":42,"checks":{"pending":1}}'
  expect(claudeToolResponse({ ok: true, text, format: 'json' })).toEqual({
    content: [{ type: 'text', text }], structuredContent: { number: 42, checks: { pending: 1 } },
  })
  expect(claudeToolResponse({ ok: false, text: 'Refused.' })).toEqual({
    content: [{ type: 'text', text: 'Refused.' }], isError: true,
  })
})

test('stack discovery batches the missing layers and makes no request for held layers', async () => {
  const { review, sent } = githubReadFixture()
  const first = await review.agentLinkedPullRequests(repo, [1, 2])
  const next = await review.agentLinkedPullRequests(repo, [1, 2, 3])
  expect(sent.map(entry => [...entry.query.matchAll(/p(\d+): pullRequest/g)].map(match => match[1])))
    .toEqual([['1', '2'], ['3']])
  expect(next.get(2)).toEqual(first.get(2))
  expect(next.get(3)?.stack).toMatchObject({ number: 4, position: 3 })
  await review.agentLinkedPullRequests(repo, [1, 2, 3])
  expect(sent).toHaveLength(2)
})

test('CI gets a fresh combined check snapshot without requesting review threads', async () => {
  const { review, sent } = githubReadFixture()
  await review.agentPullRequestSummary(repo, 42, { body: false })
  await review.agentPullRequestSummary(repo, 42, { body: false, checksOnly: true })
  await review.agentPullRequestSummary(repo, 42, { body: false, checksOnly: true })
  await review.agentPullRequestSummary(repo, 42, { body: false, fresh: true, checksOnly: true })
  expect(sent.map(entry => [entry.variables.body, entry.variables.threads])).toEqual([[false, true], [false, false], [false, false]])
})

test('a merge passes the expected head to the GitHub write', async () => {
  const sent: string[] = []
  const client = { rest: { pulls: { merge: async (request: { sha: string }) => {
    sent.push(request.sha)
    return { data: { merged: true } }
  } } }, credential: { source: 'host', token: 'test' } } as GitHubClient
  class TestProvider extends GitHubProvider {
    protected async clients() { return [client] }
  }
  expect((await new TestProvider().mergePullRequest(repo, 2, 'squash', headSha)).merged).toBe(true)
  expect(sent).toEqual([headSha])
})

test('CI picks failures or a named check and does not follow foreign job links', () => {
  const passed = check(1, 'success')
  const failed = check(2)
  expect(selectChecks([passed, failed])).toEqual([failed])
  expect(selectChecks([passed, failed], 'JOB 1')).toEqual([passed])
  expect(actionsJobId(repo, failed)).toBe(2)
  expect(actionsJobId(repo, { ...failed, detailsUrl: 'https://github.com/foreign/app/actions/runs/1/job/2' })).toBeNull()
})

test('CI reads a bounded log tail and reruns a workflow only for the selected failed jobs', async () => {
  const sent: string[] = []
  const client = { rest: {
    request: async () => ({ data: new Response('one\ntwo\nthree\n').body }),
    actions: {
      getJobForWorkflowRun: async () => ({ data: { head_sha: headSha, run_id: 1, check_run_url: '' } }),
      listJobsForWorkflowRun: async () => ({ data: { total_count: 2, jobs: [
        { id: 1, conclusion: 'failure' }, { id: 2, conclusion: 'failure' },
      ] } }),
      reRunJobForWorkflowRun: async ({ job_id }: { job_id: number }) => { sent.push(`job:${job_id}`) },
      reRunWorkflowFailedJobs: async ({ run_id }: { run_id: number }) => { sent.push(`run:${run_id}`) },
    },
  } } as GitHubClient
  expect(await readActionsCheckLog(client, repo, check(1), headSha, 2))
    .toMatchObject({ log: 'two\nthree', truncated: true, detail: null })
  expect((await rerunActionsChecks(client, repo, [check(1)], headSha)).map(check => check.rerun)).toEqual([true])
  expect((await rerunActionsChecks(client, repo, [check(1), check(2)], headSha)).map(check => check.rerun)).toEqual([true, true])
  expect(sent).toEqual(['job:1', 'run:1'])
})

test('an absent Actions log uses check annotations without a successful-job probe', async () => {
  const sent: string[] = []
  const client = { rest: {
    request: async () => { sent.push('log'); throw Object.assign(new Error('No log'), { status: 404 }) },
    checks: {
      get: async () => { sent.push('summary'); return { data: { conclusion: 'failure', output: { title: 'Build blocked', summary: 'Billing' } } } },
      listAnnotations: async () => { sent.push('annotations'); return { data: [{ annotation_level: 'failure', message: 'Run never started' }] } },
    },
  } } as GitHubClient
  const result = await readActionsCheckLog(client, repo, check(1), headSha, 200)
  expect(result.log).toBeNull()
  expect(result.detail).toContain('failure: Run never started')
  expect(sent).toEqual(['log', 'summary', 'annotations'])
})

test('CI refuses a moved head even when GitHub returns the same check run ID', async () => {
  const sent: string[] = []
  const client = { rest: { actions: {
    getJobForWorkflowRun: async () => ({ data: { head_sha: 'moved', run_id: 1, check_run_url: 'https://api.github.com/check-runs/1' } }),
    reRunJobForWorkflowRun: async () => { sent.push('rerun') },
  } } } as GitHubClient
  expect(await rerunActionsChecks(client, repo, [check(1)], headSha)).toEqual([
    { name: 'job 1', rerun: false, detail: expect.stringContaining('current PR head') },
  ])
  expect(sent).toEqual([])
})
