import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// WHY: the acting session tools are thin adapters over the orchestrator. What
// matters is that each hands the orchestrator the order the agent asked for,
// names the calling session as the sender, files a started session under the
// task the agent chose — a forgotten task puts the child outside the parent's
// view — and returns a result the host can read back after a reload: the card
// rebuilt from history must find the same message id the live card used. The
// retired tools must be gone, not stubbed.

let sessionTools: typeof import('@solus/server/sessions/session-tools')
let projection: typeof import('@solus/server/server/result-projection')
let taskStore: typeof import('@solus/server/tasks/task-store')
let TaskModule: typeof import('@solus/server/tasks/task')
let closeDb: typeof import('@solus/server/db')['closeDb']

/** The peer's transcript. Messages 3 and 4 share one timestamp. */
const transcript: SessionLoadMessage[] = [1, 2, 3, 3, 5, 6].map((timestamp, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `message ${index + 1}`, timestamp: timestamp * 1000,
}))

interface Call { method: string; args: unknown[] }
const calls: Call[] = []
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionTools = await import('@solus/server/sessions/session-tools')
  projection = await import('@solus/server/server/result-projection')
  taskStore = await import('@solus/server/tasks/task-store')
  TaskModule = await import('@solus/server/tasks/task')
  ;({ closeDb } = await import('@solus/server/db'))
  sessionTools.setSessionController({
    getSessionInfo: async (sessionId: string) => ({ sessionId, provider: 'codex', cwd: '/repo', slug: 'peer' }),
    liveStatus: () => 'running',
    pendingInputEvents: () => [],
    loadSessionTail: async (_provider: string, _sessionId: string, _projectPath: string | undefined, limit?: number) =>
      limit ? transcript.slice(-limit) : transcript,
    listAgentTargets: async () => [{
      provider: 'codex', label: 'Codex', available: true, defaultModel: 'gpt-test',
      models: [{ id: 'gpt-test', label: 'GPT', reasoningLevels: ['medium'], defaultReasoningEffort: 'medium', defaultContextWindow: 1000 }],
    }],
  } as never)
  sessionTools.setSessionOrchestration({
    spawn: async (...args) => { calls.push({ method: 'spawn', args }); return { exchangeId: 'm-created', agentSessionId: 'thread-child', taskId: 'task-child' } },
    send: async (...args) => {
      calls.push({ method: 'send', args })
      const waitMs = (args[2] as { waitMs?: number }).waitMs ?? 0
      return waitMs > 0
        ? { exchangeId: 'm-sent', disposition: 'queued', waited: { type: 'report', report: { messageId: 'm-sent', agentSessionId: 'thread-peer', status: 'completed', outputs: [{ kind: 'work', workId: 'w1', title: 'Notes', workType: 'doc' }], reply: 'checked' } } }
        : { exchangeId: 'm-sent', disposition: 'queued' }
    },
    stop: (...args) => { calls.push({ method: 'stop', args }); return true },
  })
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const deps = (sessionId = 'thread-parent') => ({ ctx: { agentProvider: 'codex' as const, cwd: '/repo', sessionId } })
const start = { prompt: 'build it', model_id: 'gpt-test' }

/** The history row a tool result becomes, as a reloading client receives it. */
function reloaded(toolName: string, result: string) {
  const rows: SessionLoadMessage[] = [
    { role: 'tool', toolName, toolId: 't1', content: '', timestamp: 1 },
    { role: 'tool_result', toolResultForId: 't1', content: result, timestamp: 2 },
  ]
  return projection.projectSessionHistory(rows)[1]!.agentConversationResult
}

/** A calling session bound to `taskId` as its working task. */
async function bind(sessionId: string, taskId: string): Promise<void> {
  await (await TaskModule.Task.byId('local', taskId)).linkSession(sessionId, 'working')
}

describe('the acting session tools', () => {
  test('send_session sends from the calling session and returns the message it opened', async () => {
    calls.length = 0
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'thread-peer', message: 'next step', delivery: 'steer', report: true }, deps())
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ method: 'send', args: ['thread-parent', 'thread-peer', { prompt: 'next step', delivery: 'steer', notify: true, waitMs: 0 }] }])
    expect(reloaded('mcp__solus__send_session', result.text)).toEqual({ agentSessionId: 'thread-peer', messageId: 'm-sent', provider: 'codex' })
  })

  test('send_session with report off asks for nothing back', async () => {
    calls.length = 0
    await sessionTools.executeSessionTool('send_session', { session_id: 'thread-peer', message: 'fyi', report: false }, deps())
    expect(calls[0]!.args[2]).toEqual({ prompt: 'fyi', delivery: 'queue', notify: false, waitMs: 0 })
  })

  test('send_session with wait_seconds returns the report it waited for, and a reload reads it from the result', async () => {
    calls.length = 0
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'thread-peer', message: 'check', wait_seconds: 30 }, deps())
    expect(calls[0]!.args[2]).toMatchObject({ waitMs: 30_000 })
    expect(result.text).toContain('It finished while you waited')
    expect(result.text.endsWith('Reply:\nchecked')).toBe(true)
    expect(reloaded('send_session', result.text)).toEqual({
      agentSessionId: 'thread-peer', messageId: 'm-sent', provider: 'codex',
      report: { messageId: 'm-sent', agentSessionId: 'thread-peer', status: 'completed', outputs: [{ kind: 'work', workId: 'w1', title: 'Notes', workType: 'doc' }], reply: 'checked' },
    })
  })

  test('wait_seconds past the limit is refused', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('send_session', { session_id: 'thread-peer', message: 'x', wait_seconds: 601 }, deps())).ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('start_session with task=independent spawns a new top-level task under the caller', async () => {
    calls.length = 0
    const result = await sessionTools.executeSessionTool('start_session', { ...start, task: 'independent', report: false }, deps())
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'spawn', args: ['thread-parent', { prompt: 'build it', provider: 'codex', modelId: 'gpt-test', cwd: '/repo', taskId: null, parentTaskId: null }, false, 0] })
    expect(reloaded('start_session', result.text)).toEqual({ agentSessionId: 'thread-child', messageId: 'm-created', provider: 'codex' })
  })

  test('start_session with task=subtask files the child under the caller\'s root task, from a task or a subtask', async () => {
    const root = await taskStore.createTask('local', { title: 'Ship the store', projectKey: '/repo', body: '' })
    const part = await taskStore.createTask('local', { title: 'Part one', projectKey: '/repo', body: '', parentId: root.id })
    await bind('thread-on-root', root.id)
    await bind('thread-on-part', part.id)

    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', { ...start, task: 'subtask' }, deps('thread-on-root'))).ok).toBe(true)
    expect(calls[0]!.args[1]).toMatchObject({ taskId: null, parentTaskId: root.id })
    // Tasks have two levels: a session on a subtask starts a sibling.
    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', { ...start, task: 'subtask' }, deps('thread-on-part'))).ok).toBe(true)
    expect(calls[0]!.args[1]).toMatchObject({ taskId: null, parentTaskId: root.id })
    expect(calls[0]!.args[2]).toBe(true)
  })

  test('start_session with task=subtask from a session with no task is refused, not filed at the top', async () => {
    calls.length = 0
    const result = await sessionTools.executeSessionTool('start_session', { ...start, task: 'subtask' }, deps('thread-without-task'))
    expect(result.ok).toBe(false)
    expect(result.text).toContain("task='independent'")
    expect(calls).toEqual([])
  })

  test('start_session with task=attempt needs the task, and runs on it', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', { ...start, task: 'attempt' }, deps())).ok).toBe(false)
    expect(calls).toEqual([])
    expect((await sessionTools.executeSessionTool('start_session', { ...start, task: 'attempt', task_id: 'task-7' }, deps())).ok).toBe(true)
    expect(calls[0]!.args[1]).toMatchObject({ taskId: 'task-7', parentTaskId: null })
  })

  test('start_session without a task choice is refused', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', start, deps())).ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('read_task_sessions shows the caller\'s own task by default, and needs a task otherwise', async () => {
    const root = await taskStore.createTask('local', { title: 'Coordinate the work', projectKey: '/repo', body: '' })
    await bind('thread-coordinator', root.id)
    const view = await sessionTools.executeSessionTool('read_task_sessions', {}, deps('thread-coordinator'))
    expect(view.ok).toBe(true)
    expect(view.text).toContain(`Task ${root.id}`)
    expect(await sessionTools.executeSessionTool('read_task_sessions', {}, deps('thread-without-task'))).toEqual({ ok: false, text: 'This session has no task. Pass task_id.' })
  })

  test('stop_session stops the target on behalf of the caller', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('stop_session', { session_id: 'thread-peer' }, deps())).ok).toBe(true)
    expect(calls).toEqual([{ method: 'stop', args: ['thread-parent', 'thread-peer'] }])
  })

  test('a session cannot message itself', async () => {
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'thread-parent', message: 'hi' }, deps())
    expect(result).toEqual({ ok: false, text: 'Cannot message your own session.' })
  })

  test('the tools the redesign replaced are gone', async () => {
    expect(sessionTools.sessionAgentTools.map((tool) => tool.name)).toEqual([
      'list_agent_targets', 'search_sessions', 'read_session', 'read_task_sessions', 'start_session', 'send_session', 'stop_session',
    ])
    for (const retired of ['wait_for_session', 'create_session', 'prompt_session', 'find_sessions']) {
      expect((await sessionTools.executeSessionTool(retired, { session_id: 'thread-peer' }, deps())).ok).toBe(false)
    }
  })
})

// WHY: a parent following a long-running child reads it again and again. Reading
// the whole transcript each time fills the parent's context; a cursor lets it
// read only what is new, and a page must never skip a message by ending inside
// a run of messages that share one timestamp.
describe('read_session with a cursor', () => {
  const read = async (args: Record<string, unknown>) => (await sessionTools.executeSessionTool('read_session', { session_id: 'thread-peer', ...args }, deps())).text
  const cursorOf = (text: string) => Number(/cursor: (\d+)/.exec(text)?.[1])

  test('a plain read ends with the cursor after the last message', async () => {
    const text = await read({ tail: 2 })
    expect(text).toContain('message 6')
    expect(cursorOf(text)).toBe(6000)
  })

  test('since returns only what came after, oldest first, and continues where it stopped', async () => {
    const first = await read({ since: 1000, tail: 2 })
    // Two asked for; the page runs on to the end of the equal-timestamp run.
    expect(first).toContain('message 2')
    expect(first).toContain('message 3')
    expect(first).toContain('message 4')
    expect(first).not.toContain('message 1')
    expect(first).not.toContain('message 5')
    expect(first).toContain('2 more after these')
    expect(cursorOf(first)).toBe(3000)

    const second = await read({ since: cursorOf(first), tail: 10 })
    expect(second).toContain('message 5')
    expect(second).toContain('message 6')
    expect(second).not.toContain('message 4')
    expect(cursorOf(second)).toBe(6000)

    const none = await read({ since: 6000 })
    expect(none).toContain('(nothing new)')
    expect(cursorOf(none)).toBe(6000)
  })
})
