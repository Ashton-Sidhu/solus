import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { encodePathAsFolder } from '../../src/shared/types'
import type { SessionMeta, SessionStatus } from '../../src/shared/types'

// session-tools imports the indexer, which imports node:sqlite (absent under
// Bun's test runtime). Shim with bun:sqlite before dynamically importing the SUT.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ToolsModule = typeof import('../../src/main/sessions/session-tools')
type IndexerModule = typeof import('../../src/main/db/session-indexer')
type DbModule = typeof import('../../src/main/db')
let tools: ToolsModule
let indexer: IndexerModule
let closeDb: DbModule['closeDb']

const CWD = '/Users/test/proj'
const PROJECT = encodePathAsFolder(CWD)

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tools = await import('../../src/main/sessions/session-tools')
  indexer = await import('../../src/main/db/session-indexer')
  ;({ closeDb } = await import('../../src/main/db'))
})
afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})
afterEach(() => {
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    provider: 'codex',
    sessionId: 'target-1',
    slug: null,
    firstMessage: null,
    lastTimestamp: '',
    size: 0,
    cwd: CWD,
    projectPath: PROJECT,
    ...overrides,
  }
}

interface FakeController {
  calls: { watch: Array<[string, string]> }
  liveStatusValue: SessionStatus | null
  metaValue: SessionMeta | null
}

function installController(state: FakeController): void {
  tools.setSessionController({
    listSessions: async () => [],
    getSessionInfo: async () => state.metaValue,
    loadSessionTail: async () => [],
    liveStatus: () => state.liveStatusValue,
    pendingInputEvents: () => [],
    promptSession: async () => ({ queued: false }),
    watchSessionSettled: (target, caller) => { state.calls.watch.push([target, caller]) },
    stopSession: () => true,
  })
}

describe('search_sessions executor', () => {
  function seedProject(root: string, sessionId: string, text: string): void {
    indexer.persistIndexedSessionStart(sessionId, 'codex', root, encodePathAsFolder(root), 'gpt-5.5', 'high')
    indexer.indexSessionMessages(sessionId, 'codex', [{ role: 'user', content: text, timestamp: Date.now() }])
  }

  test('searches all projects by default and emits links carrying cwd + project label', async () => {
    seedProject('/Users/test/t3code', 'found-1', 'the pelican migration plan')
    seedProject('/Users/test/solus', 'found-2', 'a different pelican elsewhere')
    const result = await tools.executeSessionTool('search_sessions', { query: 'pelican' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    // cross-project: both projects present
    expect(result.text).toContain('sessionId=found-1')
    expect(result.text).toContain('sessionId=found-2')
    // link carries the cwd for cross-project open
    expect(result.text).toContain(`&cwd=${encodeURIComponent('/Users/test/t3code')}`)
    // each hit labelled with its project
    expect(result.text).toContain('project: t3code')
  })

  test('project param resolves a partial name and scopes (typo-tolerant via substring)', async () => {
    seedProject('/Users/test/t3code', 'in-t3', 'pelican in t3code')
    seedProject('/Users/test/solus', 'in-solus', 'pelican in solus')
    const result = await tools.executeSessionTool('search_sessions', { query: 'pelican', project: 't3cod' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Scoped to project t3code')
    expect(result.text).toContain('sessionId=in-t3')
    expect(result.text).not.toContain('sessionId=in-solus')
  })

  test('ambiguous project returns candidates instead of guessing', async () => {
    seedProject('/Users/test/work/api', 'api-1', 'pelican work api')
    seedProject('/Users/test/personal/api', 'api-2', 'pelican personal api')
    const result = await tools.executeSessionTool('search_sessions', { query: 'pelican', project: 'api' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('No single project matched')
    expect(result.text).toContain('/Users/test/work/api')
    expect(result.text).toContain('/Users/test/personal/api')
  })

  test('returns a friendly message when nothing matches', async () => {
    const result = await tools.executeSessionTool('search_sessions', { query: 'nothingmatchesxyz' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('No matching sessions.')
  })

  test('rejects an empty query', async () => {
    const result = await tools.executeSessionTool('search_sessions', { query: '   ' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(false)
  })
})

describe('create_session executor', () => {
  function installCreator(id: string): void {
    tools.setSessionCreator(async () => ({ agentSessionId: id }))
  }

  test('rejects a missing model_id', async () => {
    installCreator('new-1')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('model_id')
  })

  test('rejects an unknown model id for the provider', async () => {
    installCreator('new-1')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code', model_id: 'not-a-real-model' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(false)
    expect(result.text.toLowerCase()).toContain('unknown model')
  })

  test('emits a session link on success', async () => {
    installCreator('spawned-42')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code', model_id: 'claude-sonnet-5' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('session://open?provider=claude-code&sessionId=spawned-42')
    expect(result.text).toContain(`&cwd=${encodeURIComponent(CWD)}`)
  })
})

describe('wait_for_session executor', () => {
  test('rejects watching your own session', async () => {
    const state: FakeController = { calls: { watch: [] }, liveStatusValue: 'running', metaValue: meta() }
    installController(state)
    const result = await tools.executeSessionTool('wait_for_session', { session_id: 'me' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(false)
    expect(state.calls.watch.length).toBe(0)
  })

  test('does not register a watcher when the target is not busy', async () => {
    const state: FakeController = { calls: { watch: [] }, liveStatusValue: 'idle', metaValue: meta() }
    installController(state)
    const result = await tools.executeSessionTool('wait_for_session', { session_id: 'target-1' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(state.calls.watch.length).toBe(0)
    expect(result.text).toContain('read_session')
  })

  test('registers a watcher exactly once when the target is busy', async () => {
    const state: FakeController = { calls: { watch: [] }, liveStatusValue: 'running', metaValue: meta() }
    installController(state)
    const result = await tools.executeSessionTool('wait_for_session', { session_id: 'target-1' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(state.calls.watch).toEqual([['target-1', 'me']])
  })
})
