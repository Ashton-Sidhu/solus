import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { encodePathAsFolder } from '@solus/contracts/types'
import type { AgentTarget, SessionMeta, SessionStatus } from '@solus/contracts/types'
import type { SessionCreateRequest } from '@solus/server/sessions/session-tools'

// session-tools imports the indexer, which imports node:sqlite (absent under
// Bun's test runtime). Shim with bun:sqlite before dynamically importing the SUT.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ToolsModule = typeof import('@solus/server/sessions/session-tools')
type IndexerModule = typeof import('@solus/server/db/session-indexer')
type DelegationsModule = typeof import('@solus/server/sessions/session-delegations')
type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskSessionsModule = typeof import('@solus/server/tasks/task-sessions')
let tools: ToolsModule
let indexer: IndexerModule
let delegations: DelegationsModule
let closeDb: DbModule['closeDb']
let taskStore: TaskStoreModule
let taskSessions: TaskSessionsModule

const CWD = '/Users/test/proj'
const PROJECT = encodePathAsFolder(CWD)

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tools = await import('@solus/server/sessions/session-tools')
  indexer = await import('@solus/server/db/session-indexer')
  delegations = await import('@solus/server/sessions/session-delegations')
  ;({ closeDb } = await import('@solus/server/db'))
  taskStore = await import('@solus/server/tasks/task-store')
  taskSessions = await import('@solus/server/tasks/task-sessions')
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
  calls: {
    watch: Array<[string, string]>
    prompt?: Array<[string, string, 'queue' | 'steer' | undefined]>
    delegation?: Array<{ childSessionId: string; parentSessionId: string; intent: 'delegate' | 'fire_and_forget' }>
  }
  liveStatusValue: SessionStatus | null
  metaValue: SessionMeta | null
  promptDisposition?: 'started' | 'steered' | 'queued'
  targets?: AgentTarget[]
  sessions?: SessionMeta[]
}

function installController(state: FakeController): void {
  tools.setSessionController({
    listAgentTargets: async () => state.targets ?? [],
    listSessions: async () => state.sessions ?? [],
    getSessionInfo: async () => state.metaValue,
    loadSessionTail: async () => [],
    liveStatus: () => state.liveStatusValue,
    pendingInputEvents: () => [],
    promptSession: async (sessionId, prompt, delivery) => {
      ;(state.calls.prompt ??= []).push([sessionId, prompt, delivery])
      return { disposition: state.promptDisposition ?? 'started' }
    },
    watchSessionSettled: (target, caller) => { state.calls.watch.push([target, caller]) },
    stopSession: () => true,
    answerQuestion: () => true,
    respondPermission: () => true,
    loadPlanContent: async () => null,
    listPlans: async () => [],
    invalidatePlanCaches: () => {},
    recordSessionDelegation: (input) => {
      ;(state.calls.delegation ??= []).push({
        childSessionId: input.childSessionId,
        parentSessionId: input.parentSessionId,
        intent: input.intent,
      })
      return true
    },
  })
}

const CLAUDE_TARGET: AgentTarget = {
  provider: 'claude-code',
  label: 'Claude Code',
  available: true,
  defaultModel: 'claude-sonnet-5',
  models: [{
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    reasoningLevels: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    defaultContextWindow: 200_000,
  }],
}

describe('list_agent_targets executor', () => {
  test('reports the configured runtime catalogue', async () => {
    installController({
      calls: { watch: [] },
      liveStatusValue: null,
      metaValue: null,
      targets: [CLAUDE_TARGET],
    })

    const result = await tools.executeSessionTool('list_agent_targets', {})

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ targets: [CLAUDE_TARGET] })
  })
})

describe('session delegation persistence', () => {
  test('preserves root and depth across nested delegated sessions', () => {
    for (const sessionId of ['root', 'child', 'grandchild']) {
      indexer.persistIndexedSessionStart(sessionId, 'codex', CWD, PROJECT, 'gpt-5.5', 'high')
    }

    expect(delegations.recordSessionDelegation({
      childSessionId: 'child',
      parentSessionId: 'root',
      exchangeId: 'exchange-1',
      intent: 'delegate',
      createdAt: 100,
    })).toBe(true)
    expect(delegations.recordSessionDelegation({
      childSessionId: 'grandchild',
      parentSessionId: 'child',
      exchangeId: 'exchange-2',
      intent: 'fire_and_forget',
      createdAt: 200,
    })).toBe(true)

    expect(indexer.getIndexedSession('child')?.delegation).toEqual({
      parentSessionId: 'root',
      rootSessionId: 'root',
      exchangeId: 'exchange-1',
      depth: 1,
      intent: 'delegate',
      createdAt: 100,
    })
    expect(indexer.getIndexedSession('grandchild')?.delegation).toEqual({
      parentSessionId: 'child',
      rootSessionId: 'root',
      exchangeId: 'exchange-2',
      depth: 2,
      intent: 'fire_and_forget',
      createdAt: 200,
    })

    // WHY: provider history refreshes own the session index row but must not
    // erase Solus-owned orchestration lineage stored beside it.
    indexer.cacheIndexedSessions([meta({ sessionId: 'grandchild' })])
    expect(indexer.getIndexedSession('grandchild')?.delegation?.rootSessionId).toBe('root')
  })
})

describe('session links', () => {
  test('includes a client-stamped host when metadata carries one', () => {
    const link = tools.sessionLink(meta({ serverId: 'studio' }))

    expect(link).toContain('&serverId=studio')
  })
})

describe('search_sessions executor', () => {
  function seedProject(root: string, sessionId: string, text: string): void {
    indexer.persistIndexedSessionStart(sessionId, 'codex', root, encodePathAsFolder(root), 'gpt-5.5', 'high')
    indexer.indexSessionMessages(sessionId, 'codex', [{ role: 'user', content: text, timestamp: Date.now() }])
  }

  test('searches all projects by default and emits links carrying cwd + project label', async () => {
    seedProject('/Users/test/solus', 'found-1', 'the pelican migration plan')
    seedProject('/Users/test/solus', 'found-2', 'a different pelican elsewhere')
    const result = await tools.executeSessionTool('search_sessions', { query: 'pelican' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    // cross-project: both projects present
    expect(result.text).toContain('sessionId=found-1')
    expect(result.text).toContain('sessionId=found-2')
    // link carries the cwd for cross-project open
    expect(result.text).toContain(`&cwd=${encodeURIComponent('/Users/test/solus')}`)
    // each hit labelled with its project
    expect(result.text).toContain('project: solus')
  })

  test('project param resolves a partial name and scopes (typo-tolerant via substring)', async () => {
    seedProject('/Users/test/solus', 'in-solus', 'pelican in solus')
    const result = await tools.executeSessionTool('search_sessions', { query: 'pelican', project: 'solus' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Scoped to project solus')
    expect(result.text).toContain('sessionId=in-solus')
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

  test('rejects a call without an explicit mode', async () => {
    // WHY: mode has no default on purpose — the caller must commit to
    // delegate vs fire-and-forget instead of silently inheriting one.
    installCreator('new-1')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code', model_id: 'claude-sonnet-5' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("'delegate'")
    expect(result.text).toContain("'fire_and_forget'")
  })

  test('rejects a missing model_id', async () => {
    installCreator('new-1')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code', mode: 'delegate' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('model_id')
  })

  test('rejects an unknown model id for the provider', async () => {
    installCreator('new-1')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code', model_id: 'not-a-real-model', mode: 'delegate' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(false)
    expect(result.text.toLowerCase()).toContain('unknown model')
  })

  test('emits a session link and the delegate follow-up on success', async () => {
    installCreator('spawned-42')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code', model_id: 'claude-sonnet-5', mode: 'delegate' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('session://open?provider=claude-code&sessionId=spawned-42')
    expect(result.text).toContain(`&cwd=${encodeURIComponent(CWD)}`)
    expect(result.text).toContain('[session report]')
  })

  test('tells a fire-and-forget caller no report will arrive', async () => {
    // WHY: the result text is the model's post-call contract — fire-and-forget
    // must not leave it waiting or polling for a reply that never comes.
    installCreator('spawned-43')
    const result = await tools.executeSessionTool('create_session', { prompt: 'go', agent_provider: 'claude-code', model_id: 'claude-sonnet-5', mode: 'fire_and_forget' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'me' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('no report will arrive')
    expect(result.text).not.toContain('[session report]')
  })

  test('records durable lineage after the child receives its real session id', async () => {
    const state: FakeController = {
      calls: { watch: [] },
      liveStatusValue: null,
      metaValue: null,
      targets: [CLAUDE_TARGET],
    }
    installController(state)
    installCreator('spawned-with-lineage')

    const result = await tools.executeSessionTool('create_session', {
      prompt: 'go',
      agent_provider: 'claude-code',
      model_id: 'claude-sonnet-5',
      mode: 'delegate',
    }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'parent-session' },
    })

    expect(result.ok).toBe(true)
    expect(state.calls.delegation).toEqual([{
      childSessionId: 'spawned-with-lineage',
      parentSessionId: 'parent-session',
      intent: 'delegate',
    }])
  })

  test('passes explicit task ownership through and reports the created subtask', async () => {
    // WHY: orchestrators need one atomic operation that both starts a worker
    // and places its work beneath the correct task. Requiring a follow-up link
    // can race the worker's first prompt and loses the parent relationship.
    let request: SessionCreateRequest | undefined
    tools.setSessionCreator(async (input) => {
      request = input
      return { agentSessionId: 'spawned-subtask', taskId: 'child-task' }
    })

    const result = await tools.executeSessionTool('create_session', {
      prompt: 'Implement focused tests',
      agent_provider: 'claude-code',
      model_id: 'claude-sonnet-5',
      mode: 'delegate',
      parent_task_id: 'parent-task',
    }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'parent-session' },
    })

    expect(result.ok).toBe(true)
    expect(request).toMatchObject({ parentTaskId: 'parent-task', taskId: null })
    expect(result.text).toContain('Bound to task child-task, a new subtask of parent-task')
  })

  test('rejects conflicting task and parent task ownership', async () => {
    installCreator('not-created')
    const result = await tools.executeSessionTool('create_session', {
      prompt: 'Ambiguous work',
      agent_provider: 'claude-code',
      model_id: 'claude-sonnet-5',
      mode: 'delegate',
      task_id: 'existing-task',
      parent_task_id: 'parent-task',
    }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'parent-session' },
    })

    expect(result.ok).toBe(false)
    expect(result.text).toContain('either task_id or parent_task_id')
  })
})

describe('session task context', () => {
  test('list and read expose a worker subtask and its parent', async () => {
    // WHY: orchestration tools should reveal task ownership without requiring
    // a second task lookup for every worker session.
    const parent = await taskStore.createTask({ title: 'Coordinate release', projectKey: CWD })
    const child = await taskSessions.prepareSessionTask({
      parentTaskId: parent.id,
      sessionId: 'target-1',
      projectKey: CWD,
      prompt: 'Verify the release',
    })
    const session = meta({ status: 'running' })
    const state: FakeController = {
      calls: { watch: [] },
      liveStatusValue: 'running',
      metaValue: session,
      sessions: [session],
    }
    installController(state)

    const listed = await tools.executeSessionTool('list_sessions', {}, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })
    const read = await tools.executeSessionTool('read_session', { session_id: 'target-1' }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })

    expect(listed.text).toContain(`${child!.id} [in_progress] Verify the release (subtask of ${parent.id})`)
    expect(read.text).toContain(`task: ${child!.id} [in_progress] Verify the release`)
    expect(read.text).toContain(`parent task: ${parent.id} [todo] Coordinate release`)
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

describe('prompt_session executor', () => {
  test('teaches agents to steer only for an in-progress redirect', () => {
    const promptTool = tools.promptSessionAgentTool

    expect(promptTool.description).toContain("work in progress should change now")
    expect(promptTool.description).toContain("Choose 'queue' for independent or sequential follow-up")
    expect(promptTool.inputShape.delivery.description).toContain("interrupt or redirect the target's current line of work")
  })

  test('queues by default for agent-to-agent delivery', async () => {
    const state: FakeController = {
      calls: { watch: [] },
      liveStatusValue: 'running',
      metaValue: meta(),
      promptDisposition: 'queued',
    }
    installController(state)

    const result = await tools.executeSessionTool('prompt_session', {
      session_id: 'target-1',
      prompt: 'Continue after your current work',
      notify_on_completion: false,
    }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })

    expect(result.ok).toBe(true)
    expect(state.calls.prompt).toEqual([['target-1', 'Continue after your current work', 'queue']])
    expect(result.text).toContain('Queued prompt for')
  })

  test('lets an agent explicitly steer another active session', async () => {
    const state: FakeController = {
      calls: { watch: [] },
      liveStatusValue: 'running',
      metaValue: meta(),
      promptDisposition: 'steered',
    }
    installController(state)

    const result = await tools.executeSessionTool('prompt_session', {
      session_id: 'target-1',
      prompt: 'Use the smaller implementation',
      delivery: 'steer',
      notify_on_completion: false,
    }, {
      ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'me' },
    })

    expect(result.ok).toBe(true)
    expect(state.calls.prompt).toEqual([['target-1', 'Use the smaller implementation', 'steer']])
    expect(result.text).toContain('Steered the active turn in')
  })
})
