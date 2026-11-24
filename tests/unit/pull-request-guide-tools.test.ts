import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { RepoRef } from '@solus/contracts/providers'
import type { ReviewGuide, ReviewGuideRequestOptions, ReviewGuideStatusEvent } from '@solus/contracts/review'
import type { PersonalSettingsDocument } from '@solus/contracts/settings'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { GuideSource } from '@solus/server/review/guide-jobs'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }
let storedGuide: ReviewGuide | null = null

// The checkout's code host and the guide store are the only outside reads; the rest is the real path.
const codeHost = await import('@solus/server/prs/code-host')
mock.module('@solus/server/prs/code-host', () => ({ ...codeHost, codeHostFor: async () => ({ repo, provider: { review: {} } }) }))
const guideStore = await import('@solus/server/review/pr-guide-store')
mock.module('@solus/server/review/pr-guide-store', () => ({ ...guideStore, readPrGuide: async () => storedGuide }))

const { withWorkspaceToolAuthority, assertToolMay } = await import('@solus/server/admission/workspace-tool-authority')
const { executeAgentTool } = await import('@solus/server/execution/agents/tools/agent-tool')
const { installPullRequestToolHost } = await import('@solus/server/execution/agents/tools/pull-request-tools')
const { installPullRequestGuideToolHost, pullRequestGuideTools } = await import('@solus/server/execution/agents/tools/pull-request-guide-tools')
const { ReviewGuideJobs } = await import('@solus/server/review/guide-jobs')

// A guide run acts for whoever asked for it; with no caller, the test acts as the host.
actAsHostForTests()

const owner = TEST_HANDLER_CTX.principal
const guest: Principal = {
  kind: 'guest', guestId: 'guest-1', displayName: 'Guest', deviceId: 'guest-1', deviceLabel: 'Test', expiresAt: Date.now() + 60_000,
  share: { resource: { kind: 'session', id: 'session-1' }, role: 'editor', sharedByUserId: 'local', linkSecretHash: 'test' },
}
const context: AgentToolContext = {
  provider: 'codex', cwd: '/projects/app/.solus/worktrees/feature', sessionId: () => 'session-1',
  abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {},
}

let published: ReviewGuideStatusEvent[]
let requested: ReviewGuideRequestOptions[]
let authored: number
let servesExecution: boolean
let personal: PersonalSettingsDocument

beforeEach(() => {
  storedGuide = null
  published = []
  requested = []
  authored = 0
  servesExecution = true
  personal = { reviewAgent: 'codex', reviewModel: 'gpt-6-luna', reviewReasoning: 'high' }
  // A pull request source with no I/O. Its run never ends, so a second request finds it running.
  const source: GuideSource = {
    serial: true,
    identify: async (ctx, opts) => {
      if (opts.target?.kind !== 'pr') return null
      requested.push(opts)
      const key = `${opts.target.owner}/${opts.target.repo}#${opts.target.number}`
      return { jobKey: key, identity: { repoRoot: ctx.session.gitContext?.repoRoot ?? ctx.session.projectPath, key, scope: 'pr', target: opts.target, headSha: '', baseSha: undefined } }
    },
    read: async () => storedGuide,
    live: async () => ({ headSha: 'head-1', baseSha: 'base-1' }),
    author: () => { authored++; return new Promise(() => {}) },
    write: async () => true,
  }
  const guides = new ReviewGuideJobs((event) => published.push(event), { pr: source, local: source })
  installPullRequestToolHost({ resources: undefined as never, prSync: { apply: async () => {}, refresh: () => {} }, isSessionBusy: () => false })
  installPullRequestGuideToolHost({
    guides,
    dispatcher: { seatForTurn: async () => null } as never,
    servesExecution: () => servesExecution,
    projectOf: () => '/projects/app',
    personal: async () => ({ reply: { ok: true, settings: personal, profile: [], device: null }, fromTurnClient: true }),
  })
})

function run(tool: keyof typeof pullRequestGuideTools, input: object, principal: Principal = owner) {
  return withWorkspaceToolAuthority(principal, () => executeAgentTool(pullRequestGuideTools[tool] as never, input, context))
}

describe('pull_request_guide_read', () => {
  test('never starts a run, and reads null when the PR has no guide', async () => {
    // WHY: T3 parity: reading a guide is free. Starting a run costs model time and a checkout.
    const result = await run('guideRead', { number: 7 })

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ repository: 'acme/app', number: 7, guide: null, run: null })
    expect(published).toEqual([])
    expect(authored).toBe(0)
  })

  test('reads the stored guide and its state against the live head, without the hunks', async () => {
    storedGuide = {
      version: 1, key: 'acme/app#7', headSha: 'head-0', baseSha: 'base-1', generatedAt: '2026-11-20T00:00:00Z',
      title: 'Guide', summary: 'What changed',
      sections: [{ id: 's', title: 'Parser', order: 0, significance: 'core', explanation: 'Why', files: [{ path: 'a.ts', additions: 2, deletions: 1, hunks: '@@ -1 +1 @@' }] }],
    }
    const read = JSON.parse((await run('guideRead', { number: 7 })).text)

    expect(read.guide.sections).toEqual([{ title: 'Parser', significance: 'core', explanation: 'Why', attention: null, files: [{ path: 'a.ts', additions: 2, deletions: 1 }] }])
    expect(read.run).toMatchObject({ status: 'outdated', headSha: 'head-1' })
    expect(authored).toBe(0)
  })
})

describe('pull_request_guide_write', () => {
  test('starts a run with the person’s review settings, and a second request for the same PR joins it', async () => {
    const first = JSON.parse((await run('guideWrite', { numbers: [7, 8, 7] })).text)
    expect(first.runs).toEqual([
      expect.objectContaining({ number: 7, joined: false, status: 'queued' }),
      expect.objectContaining({ number: 8, joined: false, status: 'queued' }),
    ])
    expect(requested[0]).toMatchObject({ agent: 'codex', model: 'gpt-6-luna', reasoningEffort: 'high' })
    // A guide belongs to the project, as on the PR page, not to the session's worktree.
    expect(published[0].repoRoot).toBe('/projects/app')

    const second = JSON.parse((await run('guideWrite', { numbers: [7] })).text)
    expect(second.runs).toEqual([expect.objectContaining({ number: 7, joined: true })])
    // One job per PR: the join started no second job.
    expect(published.filter((event) => event.status === 'queued' && event.target?.kind === 'pr' && event.target.number === 7)).toHaveLength(1)
  })

  test('refuses while guides are off on this host, and starts nothing', async () => {
    servesExecution = false
    const result = await run('guideWrite', { numbers: [7] })

    expect(result.ok).toBe(false)
    expect(result.text).toContain('Review guides are off on this host')
    expect(published).toEqual([])
  })

  test('refuses more than 20 PRs in one call', async () => {
    const result = await run('guideWrite', { numbers: Array.from({ length: 21 }, (_, index) => index + 1) })

    expect(result.ok).toBe(false)
    expect(published).toEqual([])
  })
})

describe('a guest’s turn', () => {
  test('is refused where the guest’s client is refused: guides are host use', async () => {
    // WHY: an agent acts with the access of the person its turn works for, never the host's.
    await expect(withWorkspaceToolAuthority(guest, () => assertToolMay('prGenerateGuides'))).rejects.toThrow('guest')
    await expect(withWorkspaceToolAuthority(guest, () => assertToolMay('readGuide'))).rejects.toThrow('guest')
    await expect(withWorkspaceToolAuthority(owner, () => assertToolMay('prGenerateGuides'))).resolves.toBeUndefined()

    for (const [tool, input] of [['guideWrite', { numbers: [7] }], ['guideRead', { number: 7 }]] as const) {
      const result = await run(tool, input, guest)
      expect(result.ok).toBe(false)
    }
    expect(published).toEqual([])
  })
})
