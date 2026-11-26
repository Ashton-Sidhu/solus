import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, SessionMeta } from '@solus/contracts/types'
import type { RepoRef } from '@solus/contracts/providers'
import type { AgentPullRequestSummary } from '@solus/server/providers/types'
import type { CodeHost } from '@solus/server/prs/code-host'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { CreateSessionOrder, OrchestratedRuntime, PromptOrder } from '@solus/server/execution/orchestration/session-orders'
import type { Principal } from '@solus/server/admission/principal'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: an outside app (Claude Desktop, Cursor) has no Solus session (plans/035
// §8). It starts and messages sessions under its requester key, and reads the
// results itself, as T3 Code's client namespace does. The key must never be
// read as a session: no report, notice, or card is sent to it, and it answers
// nothing for a person. One app never reads another app's work. A tool that
// acts on a session or a checkout takes the session or the project the app
// names, and refuses with a message the app can act on when it names none.

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }
const projectDir = mkdtempSync(join(tmpdir(), 'solus-outside-app-project-'))
const dataDir = mkdtempSync(join(tmpdir(), 'solus-outside-app-data-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = dataDir

const summary: AgentPullRequestSummary = {
  number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Fix the parser', state: 'open', isDraft: false,
  author: 'dev', headBranch: 'fix', baseBranch: 'main', headSha: 'head', baseSha: 'base', mergeability: 'mergeable',
  behindBy: 0, autoMergeEnabled: false, checkRuns: [], checksIncomplete: false, unresolvedThreads: 0, unresolvedThreadsTruncated: false,
}
const codeHost = { repo, provider: { review: { agentPullRequestSummary: async () => summary } } } as unknown as CodeHost

const realCodeHost = await import('@solus/server/prs/code-host')
mock.module('@solus/server/prs/code-host', () => ({ ...realCodeHost, codeHostFor: async (scope: string) => scope === projectDir ? codeHost : null }))

const { SessionOrchestrator } = await import('@solus/server/execution/orchestration/session-orchestrator')
const { clientRequesterKey } = await import('@solus/server/execution/orchestration/exchange')
const sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
const { linkAgentTool, listLinksAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
const { pullRequestTools, installPullRequestToolHost } = await import('@solus/server/execution/agents/tools/pull-request-tools')
const { setProjectToolHost } = await import('@solus/server/execution/agents/tools/project-tools')
const { withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority')
const { APP_TOOLS, appToolRefusal } = await import('@solus/server/execution/agents/tools/tool-access')
const { closeDb } = await import('@solus/server/db')

afterAll(() => {
  closeDb()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const APP_A = clientRequesterKey('grant-a')
const APP_B = clientRequesterKey('grant-b')
const TARGET = 'target-session'
const owner: Principal = { kind: 'owner', via: 'local', deviceId: 'grant-a', deviceLabel: 'Claude Desktop', expiresAt: null }

function appContext(requesterKey = APP_A): AgentToolContext {
  return {
    provider: 'claude-code', cwd: homedir(), sessionId: () => undefined, requesterKey: () => requesterKey,
    abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {},
  }
}

/** The orchestrator over a runtime that records every session it is asked to treat as one. */
function harness() {
  const created: CreateSessionOrder[] = []
  const prompts: Array<{ sessionId: string; order: PromptOrder }> = []
  const asSession: string[] = []
  const stops: Array<[string, string | undefined]> = []
  const work: Promise<unknown>[] = []
  const meta = { sessionId: TARGET, provider: 'codex', cwd: projectDir } as SessionMeta
  const runtime: OrchestratedRuntime = {
    activeExchangeIdsFor: (sessionId) => { asSession.push(sessionId); return [] },
    queuedExchanges: () => [],
    sessionMeta: (sessionId) => sessionId === TARGET ? meta : null,
    createSession: async (order) => { created.push(order); return { sessionId: order.sessionId! } },
    promptSession: async (sessionId, _prompt, _delivery, order) => { prompts.push({ sessionId, order }); return { disposition: 'started' } },
    releaseRateLimit: () => false,
    stopSession: (sessionId, senderSessionId) => { stops.push([sessionId, senderSessionId]); return true },
    respondToPermission: () => false, pendingInputEvents: () => [], replaceQueuedPrompt: () => false,
    hasQueuedPrompt: () => false, cancelQueuedPrompt: () => false,
    turnEnding: async () => ({}), taskIdFor: async () => undefined, turnOrganization: async () => undefined, codebase: async () => null,
    emit: (sessionId) => { asSession.push(sessionId) },
    invalidatePlanCaches: () => {},
    recordActivity: async () => { throw new Error('No person acted in this test') },
    trackWork: (promise) => { work.push(promise); return promise },
    repliesEnded: (sessionId) => { asSession.push(sessionId) },
    delegatedRequestChanged: (sessionId) => { asSession.push(sessionId) },
  }
  const orchestrator = new SessionOrchestrator(runtime, { findPullRequest: async () => null })
  return { orchestrator, created, prompts, asSession, stops, drain: () => Promise.all(work) }
}

const QUESTION: NormalizedEvent = {
  type: 'question_request', questionId: 'q-1',
  questions: [{ question: 'Which store?', options: [{ label: 'Host' }], multiSelect: false }],
}
const order = { codebaseId: null, prompt: 'Review the parser', provider: 'codex' as const, modelId: 'gpt-test', reasoningEffort: 'medium' as const, contextWindow: null, cwd: projectDir }

describe("an outside app's requester key", () => {
  test('is never used as a session, even when it asks for a report', async () => {
    const { orchestrator, created, prompts, asSession, stops, drain } = harness()
    const spawned = await orchestrator.spawn(APP_A, order, true, 0, 'retry-key')
    await drain()
    // The new session is the app's person's, and nobody's delegate.
    expect(created[0]?.sourceSessionId).toBeUndefined()
    expect(created[0]?.delegation).toBeUndefined()
    const run = { sessionId: spawned.sessionId, runId: 'run-1', exchangeIds: [spawned.exchangeId] }
    orchestrator.runStarted(run)
    orchestrator.inputRequested(run, QUESTION)
    // A person answers the question; the app has no conversation to answer from.
    expect(orchestrator.mayAnswer(APP_A, spawned.sessionId)).toBe(false)
    orchestrator.runSettled({ ...run, outcome: 'completed', resultText: 'Parser reviewed.', provider: 'codex' })
    await drain()
    orchestrator.stop(APP_A, spawned.sessionId)

    expect(asSession).not.toContain(APP_A)
    expect(prompts).toEqual([])
    expect(stops).toEqual([[spawned.sessionId, undefined]])
    const exchange = orchestrator.readExchange(APP_A, spawned.exchangeId)
    expect(exchange?.report?.reply).toBe('Parser reviewed.')
    expect(exchange?.deliveryState).toBe('disposed')
    // A retry with the same request id finds the same work.
    expect((await orchestrator.spawn(APP_A, order, true, 0, 'retry-key')).exchangeId).toBe(spawned.exchangeId)
  })
})

describe('send_session and read_session_exchange from an outside app', () => {
  test('the app reads its own exchange, and another app cannot', async () => {
    const { orchestrator, prompts, asSession, drain } = harness()
    sessionTools.setSessionOrchestration(orchestrator)
    sessionTools.setSessionController({
      getSessionInfo: async (sessionId: string) => sessionId === TARGET ? { sessionId, provider: 'codex', cwd: projectDir, slug: 'peer' } : null,
    } as never)

    const sent = await sessionTools.sendSessionAgentTool.execute({ session_id: TARGET, message: 'Check the tests.' } as never, appContext(APP_A))
    expect(sent.ok).toBe(true)
    expect(sent.text).toContain('read_session_exchange')
    const exchangeId = /exchange_id=([0-9a-f-]+)/.exec(sent.text)?.[1]
    expect(exchangeId).toBeTruthy()
    // The prompt runs for the app's person: it names no sender session.
    expect(prompts).toEqual([{ sessionId: TARGET, order: expect.objectContaining({ senderSessionId: undefined }) }])

    orchestrator.runStarted({ sessionId: TARGET, runId: 'run-2', exchangeIds: [exchangeId!] })
    orchestrator.runSettled({ sessionId: TARGET, runId: 'run-2', exchangeIds: [exchangeId!], outcome: 'completed', resultText: 'Tests pass.', provider: 'codex' })
    await drain()
    // No report was delivered: the only prompt is the app's own message.
    expect(prompts).toHaveLength(1)
    expect(asSession).not.toContain(APP_A)

    const read = await sessionTools.readSessionExchangeAgentTool.execute({ exchange_id: exchangeId } as never, appContext(APP_A))
    expect(read.ok).toBe(true)
    expect(read.text).toContain('settled')
    expect(read.text).toContain('Tests pass.')
    const other = await sessionTools.readSessionExchangeAgentTool.execute({ exchange_id: exchangeId } as never, appContext(APP_B))
    expect(other).toEqual({ ok: false, text: 'Exchange not found for this app.' })
  })
})

describe('tools that act on a session or a checkout', () => {
  test('a link tool needs session_id from an app, and says so', async () => {
    const expected = { ok: false, text: 'Pass session_id: this app is not running inside a Solus session.' }
    expect(await linkAgentTool.execute({ kind: 'work', target_id: 'w-1' } as never, appContext())).toEqual(expected)
    expect(await listLinksAgentTool.execute({}, appContext())).toEqual(expected)
  })

  test('a tool that needs a checkout of its own refuses an app', async () => {
    const result = await withWorkspaceToolAuthority(owner, () => pullRequestTools.prCreate.execute({ title: 'T', body: '' }, appContext()))
    expect(result).toEqual({ ok: false, text: 'This tool requires an active Solus session.' })
    expect(appToolRefusal({ name: 'pull_request_create', requiresApproval: true }, 'full')).toContain('only for an agent inside a Solus session')
    expect(Object.keys(APP_TOOLS)).not.toContain('pull_request_guide_write')
  })

  test('a PR read works from a project the person may use, with no session', async () => {
    installPullRequestToolHost({ resources: { standingFor: async () => { throw new Error('No session is checked') } }, prSync: { apply: async () => {}, refresh: () => {} }, isSessionBusy: () => false } as never)
    setProjectToolHost({ rpc: {
      listProjects: async () => [{ path: projectDir, folderName: 'app', repositoryKey: 'github.com/acme/app', lastUsedAt: '', addedAt: '' }],
      codebaseList: async () => [],
    } } as never)
    const read = (input: object) => withWorkspaceToolAuthority(owner, () => pullRequestTools.prRead.execute(input, appContext()))

    const result = await read({ project: projectDir, repository: 'acme/app', number: 7 })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toMatchObject({ repository: 'acme/app', number: 7, title: 'Fix the parser' })

    expect(await read({ number: 7 })).toEqual({ ok: false, text: 'Pass project: this app is not running inside a Solus session. list_projects lists the projects.' })
    expect((await read({ project: projectDir, repository: 'acme/other', number: 7 })).text).toBe(`acme/other is not the repository of the project ${projectDir}.`)
    // A folder the person cannot list is no project of theirs.
    expect((await read({ project: tmpdir(), number: 7 })).text).toBe(`No project of this host holds ${tmpdir()}. Use list_projects.`)
  })
})
