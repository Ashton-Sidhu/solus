import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/session-open-latency.md: the host parses a session's first page
// before a person opens it, so the open answers from the provider page cache.
// The cache holds provider rows only, keyed by the provider file and its
// revision: a changed file and another person's file never get a cached page.

const root = mkdtempSync(join(tmpdir(), 'solus-history-prewarm-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
const homes = { alice: join(root, 'alice'), bob: join(root, 'bob') }

/** Each parse of a provider file, counted. */
let parses = 0
const realPages = await import('@solus/server/execution/agents/claude/claude-history-page')
const realLoad = realPages.loadClaudeHistoryPage
mock.module('@solus/server/execution/agents/claude/claude-history-page', () => ({
  ...realPages,
  loadClaudeHistoryPage: (...args: Parameters<typeof realLoad>) => {
    parses++
    return realLoad(...args)
  },
}))
// Each person's Claude threads live in their own provider home.
const realInstances = await import('@solus/server/execution/seats/provider-instances')
mock.module('@solus/server/execution/seats/provider-instances', () => ({
  ...realInstances,
  privateProviderInstances: () => ({ threadHome: (personKey: string) => homes[personKey as keyof typeof homes] }),
}))

let ClaudeBackend: typeof import('@solus/server/execution/agents/claude/claude-backend')['ClaudeBackend']
let SessionHistory: typeof import('@solus/server/execution/sessions/session-history')['SessionHistory']
let HistoryPrewarm: typeof import('@solus/server/execution/sessions/history-prewarm')['HistoryPrewarm']
let withActingScope: typeof import('@solus/server/vault/acting-scope')['withActingScope']

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  mkdirSync(process.env.SOLUS_DATA_DIR)
  ;({ ClaudeBackend } = await import('@solus/server/execution/agents/claude/claude-backend'))
  ;({ SessionHistory } = await import('@solus/server/execution/sessions/session-history'))
  ;({ HistoryPrewarm } = await import('@solus/server/execution/sessions/history-prewarm'))
  ;({ withActingScope } = await import('@solus/server/vault/acting-scope'))
})

afterAll(async () => {
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

const PROJECT = '-fixture-project'
const SESSION = 'thread-1'

function line(type: 'user' | 'assistant', text: string, timestamp: number): string {
  return JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n'
}

function transcriptOf(person: keyof typeof homes): string {
  return join(homes[person], 'projects', PROJECT, `${SESSION}.jsonl`)
}

function writeTranscript(person: keyof typeof homes, reply: string): void {
  mkdirSync(join(homes[person], 'projects', PROJECT), { recursive: true })
  writeFileSync(transcriptOf(person), line('user', 'question', 1) + line('assistant', reply, 2))
}

/** A host with one resting Claude session, read as `person`. */
function hostOf(person: keyof typeof homes) {
  const backend = new ClaudeBackend()
  const runtime = {
    activeSessions: new Map(), activeRunRequests: new Map(), launcher: { pendingSetupControllers: new Map() },
    backendFor: () => backend,
  } as unknown as SessionRuntime
  const history = new SessionHistory(runtime)
  // The index is not under test: the session is this host's, in the fixture project.
  history.getSessionInfo = async (sessionId) => ({ sessionId, provider: 'claude-code', cwd: PROJECT, projectPath: PROJECT, slug: null, firstMessage: null, lastTimestamp: '', size: 1 })
  Object.assign(runtime, { history })
  const scope = { identity: {} as never, personKey: person }
  const open = (who: keyof typeof homes = person) => withActingScope({ ...scope, personKey: who }, () =>
    history.loadSessionPage({ sessionId: SESSION, provider: 'claude-code', projectPath: PROJECT, turnLimit: 5, knownHistoryBlocks: [] }))
  return { runtime, backend, history, open, prewarm: new HistoryPrewarm(runtime), scope }
}

const contents = (page: { messages: { content: string }[] }) => page.messages.map((message) => message.content)

beforeEach(() => {
  parses = 0
  writeTranscript('alice', 'alice reply')
  writeTranscript('bob', 'bob reply')
})

test('a page the host read ahead answers the open without a second parse', async () => {
  const host = hostOf('alice')
  await withActingScope(host.scope, () => host.prewarm.warm([SESSION]))
  // One parse for each first-page turn limit a client asks for.
  expect(parses).toBe(2)
  expect(contents(await host.open())).toEqual(['question', 'alice reply'])
  expect(parses).toBe(2)
})

test('an open that comes while the host reads ahead waits for that parse', async () => {
  const host = hostOf('alice')
  const warming = withActingScope(host.scope, () => host.prewarm.warm([SESSION]))
  const [page] = await Promise.all([host.open(), warming])
  expect(contents(page)).toEqual(['question', 'alice reply'])
  expect(parses).toBe(2)
})

test('a changed transcript is parsed again', async () => {
  const host = hostOf('alice')
  await withActingScope(host.scope, () => host.prewarm.warm([SESSION]))
  appendFileSync(transcriptOf('alice'), line('user', 'next', 3))
  expect(contents(await host.open())).toEqual(['question', 'alice reply', 'next'])
  expect(parses).toBe(3)
})

test('a cached page never answers a person whose provider home has another file for the thread', async () => {
  const host = hostOf('alice')
  await withActingScope(host.scope, () => host.prewarm.warm([SESSION]))
  expect(contents(await host.open('bob'))).toEqual(['question', 'bob reply'])
  expect(contents(await host.open('alice'))).toEqual(['question', 'alice reply'])
})

/** The host runs a turn in the fixture session. */
function startRun(host: ReturnType<typeof hostOf>, running = true): void {
  if (running) (host.runtime.activeSessions as Map<string, unknown>).set(SESSION, {})
  else (host.runtime.activeSessions as Map<string, unknown>).delete(SESSION)
  host.backend.isSessionRunning = () => running
}

test('a running session is read ahead too, and its page answers the open until the run writes again', async () => {
  const host = hostOf('alice')
  startRun(host)
  await withActingScope(host.scope, () => host.prewarm.warm([SESSION]))
  expect(parses).toBe(2)
  // A person opens a running session the most: the open needs no parse while the transcript is unchanged.
  expect(contents(await host.open())).toEqual(['question', 'alice reply'])
  expect(parses).toBe(2)
  appendFileSync(transcriptOf('alice'), line('user', 'next', 3))
  expect(contents(await host.open())).toContain('next')
  expect(parses).toBe(3)
})

test('a page read during a run never answers after the run ends', async () => {
  const host = hostOf('alice')
  startRun(host)
  await withActingScope(host.scope, () => host.prewarm.warm([SESSION]))
  // The newest page of a running session has no fork controls; a resting one has them.
  startRun(host, false)
  await host.open()
  expect(parses).toBe(3)
})
