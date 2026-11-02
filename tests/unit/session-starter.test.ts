import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { encodePathAsFolder } from '@solus/contracts/types'
import { hostStarterOf, parseStoredStarter, sessionStarterFromHostSchema } from '@solus/contracts/session-starter'
import { sessionRecordUpsertWireSchema } from '@solus/server/sync/runner-protocol'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionRunRequest } from '@solus/server/execution/session-runtime'

// bun has no node:sqlite; the indexer's import chain reaches it.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/session-starter.md: the host writes where a session runs and what
// started it once, when it makes the session, so every client and the Solus API
// can list and filter by them without reading a path or a live message.

let dataDir: string
let closeDb: () => void

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-starter-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

async function recordOf(sessionId: string) {
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  for (let attempt = 0; attempt < 50; attempt++) {
    const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
    if (record) return record
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`no record for ${sessionId}`)
}

describe('the record of a new session', () => {
  test('names its place from the folder the host made, and the starter the run carried', async () => {
    const indexer = await import('@solus/server/db/session-indexer')
    const chat = '/Users/me/.solus/solus-chats/chat-1'
    indexer.persistIndexedSessionStart('chat-1', 'codex', chat, encodePathAsFolder(chat), 'gpt-5.5', 'high', 'hi', null, undefined,
      { kind: 'automation', automationId: 'automation-1', runId: 'run-1' })
    const project = '/Users/me/projects/solus'
    indexer.persistIndexedSessionStart('project-1', 'claude-code', project, encodePathAsFolder(project), 'opus', 'high', 'hi', null, undefined,
      { kind: 'webhook', webhookId: 'webhook-1', deliveryId: 'delivery-1' })

    expect(await recordOf('chat-1')).toMatchObject({ place: 'chat', startedBy: { kind: 'automation', automationId: 'automation-1', runId: 'run-1' } })
    expect(await recordOf('project-1')).toMatchObject({ place: 'project', startedBy: { kind: 'webhook', webhookId: 'webhook-1', deliveryId: 'delivery-1' } })
    // The machine index reads the same facts.
    expect(indexer.getIndexedSession('chat-1')).toMatchObject({ place: 'chat' })
  })

  test('keeps its first place and starter: a later report never changes them', async () => {
    // WHY: a provider switch or a moved checkout starts a new thread of the
    // same session; that run did not start the session.
    const { upsertOwnSessionRecord } = await import('@solus/server/data/sessions/session-records')
    await upsertOwnSessionRecord({ sessionId: 'kept', provider: 'codex', projectPath: '-p', lastActivityAt: 1, place: 'project', startedBy: { kind: 'person', personKey: 'local:me' } })
    await upsertOwnSessionRecord({ sessionId: 'kept', provider: 'codex', projectPath: '-p', lastActivityAt: 2, place: 'chat', startedBy: { kind: 'session', sessionId: 'other' } })
    expect(await recordOf('kept')).toMatchObject({ place: 'project', startedBy: { kind: 'person', personKey: 'local:me' } })
  })

  test('a session made before this change has neither: it is not guessed', async () => {
    const { upsertOwnSessionRecord } = await import('@solus/server/data/sessions/session-records')
    await upsertOwnSessionRecord({ sessionId: 'old', provider: 'codex', projectPath: '-Users-me--solus-solus-chats-old', cwd: '/Users/me/.solus/solus-chats/old', lastActivityAt: 1 })
    expect(await recordOf('old')).toMatchObject({ place: null, startedBy: null })
  })
})

describe('the starter on the wire', () => {
  test('a runner delivers the place and the starter with the record', () => {
    const facts = sessionRecordUpsertWireSchema.parse({
      sessionId: 's', provider: 'codex', projectPath: '-p', lastActivityAt: 1,
      place: 'chat', startedBy: { kind: 'webhook', webhookId: 'w', deliveryId: 'd' },
    })
    expect(facts).toMatchObject({ place: 'chat', startedBy: { kind: 'webhook', webhookId: 'w', deliveryId: 'd' } })
  })

  test('another host may name only its own session as the starter', () => {
    // WHY: createHeadlessSession takes the starter from the caller. A caller
    // that could claim a person or an automation would forge the record.
    expect(sessionStarterFromHostSchema.safeParse({ kind: 'session', sessionId: 'parent', hostLabel: 'Studio' }).success).toBe(true)
    expect(sessionStarterFromHostSchema.safeParse({ kind: 'person', personKey: 'someone' }).success).toBe(false)
    expect(sessionStarterFromHostSchema.safeParse({ kind: 'session', sessionId: 'parent' }).success).toBe(false)
  })

  test('a stored value of the old origin shape reads as unknown', () => {
    expect(parseStoredStarter(JSON.stringify({ hostLabel: 'Studio', sessionId: 'parent' }))).toBeNull()
    expect(parseStoredStarter('not json')).toBeNull()
  })

  test('the transcript names a host only for a session another host started', () => {
    expect(hostStarterOf({ kind: 'session', sessionId: 'p', hostLabel: 'Studio' })).toEqual({ kind: 'session', sessionId: 'p', hostLabel: 'Studio' })
    expect(hostStarterOf({ kind: 'session', sessionId: 'p' })).toBeNull()
    expect(hostStarterOf({ kind: 'person', personKey: 'me' })).toBeNull()
  })
})

describe('each way a session starts names its starter on the run', () => {
  async function dispatchWithRuns() {
    const { PromptDispatch } = await import('@solus/server/execution/sessions/prompt-dispatch')
    const runs: SessionRunRequest[] = []
    const rt = {
      activeSessions: new Map(),
      agentSessionToSession: new Map(),
      assertNewWorkAllowed: () => {},
      seatForTurn: async () => null,
      sessionOfThread: () => undefined,
      history: { loadSessionPage: async () => ({ messages: [] }) },
      runTurn: async (request: SessionRunRequest) => {
        runs.push(request)
        return { disposition: 'started', agentSessionId: Promise.resolve({ agentSessionId: 'thread' }), done: Promise.resolve({}), cancel: () => {} }
      },
    }
    return { dispatch: new PromptDispatch(rt as never), runs }
  }
  const ctx = (sessionId: string, agentSessionId: string | null) => ({
    session: {
      sessionId, provider: 'codex', agentSessionId, status: 'idle', workingDirectory: '/repo', projectPath: '/repo', additionalDirs: [],
      gitContext: null, worktreeBaseBranch: null, preferredModel: 'gpt-5.5', reasoningEffort: 'medium', contextWindow: null,
      fastMode: false, permissionMode: 'supervised', readOnlyReason: null,
    },
    settings: { activeAgent: 'codex' },
    statusBar: { model: 'gpt-5.5', reasoningEffort: 'medium', fastMode: false },
  }) as unknown as IpcContext

  test('a local prompt that makes a session is the host user\'s; a prompt to a session names no starter', async () => {
    const { dispatch, runs } = await dispatchWithRuns()
    await dispatch.submitPrompt(ctx('new', null), { prompt: 'Go.' })
    await dispatch.submitPrompt(ctx('existing', 'thread-1'), { prompt: 'Again.' })
    expect(runs[0]?.startedBy).toMatchObject({ kind: 'person' })
    expect(runs[1]?.startedBy).toBeUndefined()
  })

  test('a webhook delivery names its webhook and delivery', async () => {
    const { HOST_ACTOR } = await import('@solus/server/admission/actor')
    const { dispatch, runs } = await dispatchWithRuns()
    await dispatch.startUnattendedSession({
      prompt: 'Review.', provider: 'codex', modelId: null, reasoningEffort: 'medium', cwd: '/repo', actor: HOST_ACTOR,
      startedBy: { kind: 'webhook', webhookId: 'w-1', deliveryId: 'd-1' },
    })
    expect(runs[0]?.startedBy).toEqual({ kind: 'webhook', webhookId: 'w-1', deliveryId: 'd-1' })
    // Only an automation's prompt carries the automation badge.
    expect(runs[0]?.options.via).toBeUndefined()
  })
})
