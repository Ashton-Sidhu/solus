import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { OrchestrationItem } from '@solus/contracts/session-exchange'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// WHY: the acting session tools are thin adapters over the orchestrator. What
// matters is that each hands the orchestrator the order the agent asked for,
// names the calling session as the sender, files a started session under the
// task the agent chose — a forgotten task puts the child outside the parent's
// view — and returns a result the host can read back after a reload: the card
// rebuilt from history must find the same message id the live card used. The
// retired tools must be gone, not stubbed.

let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let projection: typeof import('@solus/server/data/sessions/result-projection')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let TaskModule: typeof import('@solus/server/data/tasks/task')
let closeDb: typeof import('@solus/server/db')['closeDb']

/** The peer's transcript. Messages 3 and 4 share one timestamp. */
const transcript: SessionLoadMessage[] = [1, 2, 3, 3, 5, 6].map((timestamp, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `message ${index + 1}`, timestamp: timestamp * 1000,
}))

interface Call { method: string; args: unknown[] }
const calls: Call[] = []
let savedReply = 'Review passed.'
let startingReceipt = false
let startupOutcome: OrchestrationItem | undefined
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  projection = await import('@solus/server/data/sessions/result-projection')
  taskStore = await import('@solus/server/data/tasks/task-store')
  TaskModule = await import('@solus/server/data/tasks/task')
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
    spawn: async (...args) => { calls.push({ method: 'spawn', args }); return { exchangeId: 'm-created', sessionId: 'solus-child', starting: startingReceipt, taskId: 'task-child', waited: startupOutcome } },
    send: async (...args) => {
      calls.push({ method: 'send', args })
      const waitMs = (args[2] as { waitMs?: number }).waitMs ?? 0
      return waitMs > 0
        ? { exchangeId: 'm-sent', disposition: 'queued', waited: { type: 'report', report: { messageId: 'm-sent', sessionId: 'solus-peer', status: 'completed', outputs: [{ kind: 'work', workId: 'w1', title: 'Notes', workType: 'doc' }], reply: 'checked' } } }
        : { exchangeId: 'm-sent', disposition: 'queued' }
    },
    stop: (...args) => { calls.push({ method: 'stop', args }); return true },
    readExchange: (sender, exchangeId) => sender === 'solus-parent' && exchangeId === 'saved-result' ? {
      exchangeId, kind: 'prompt', senderSessionId: sender,
      targetSessionId: 'solus-peer', provider: 'codex', notify: true,
      state: 'settled', outcome: 'completed', outputs: [], notices: [], revising: false,
      dispatchedAt: 1, deliveryState: 'queued',
      report: { messageId: exchangeId, sessionId: 'solus-peer', status: 'completed', outputs: [], reply: savedReply },
    } : undefined,

  })
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const deps = (sessionId = 'solus-parent') => ({ ctx: { agentProvider: 'codex' as const, cwd: '/repo', sessionId } })
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
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'solus-peer', message: 'next step', delivery: 'steer', report: true }, deps())
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ method: 'send', args: ['solus-parent', 'solus-peer', { prompt: 'next step', delivery: 'steer', notify: true, waitMs: 0 }] }])
    expect(reloaded('mcp__solus__send_session', result.text)).toEqual({ sessionId: 'solus-peer', messageId: 'm-sent', provider: 'codex' })
  })

  test('send_session and start_session pass the files they attach as paths on this host', async () => {
    // WHY: the orchestrator uploads the files to the host that runs the
    // session, so the tool only checks them. Relative paths are the agent's
    // working directory; a retry with the same request_id names the same paths.
    const source = mkdtempSync(join(tmpdir(), 'solus-send-attachments-'))
    writeFileSync(join(source, 'shot.png'), 'png bytes')
    writeFileSync(join(source, 'log.txt'), 'log')
    calls.length = 0
    const caller = { ctx: { ...deps().ctx, cwd: source } }
    await sessionTools.executeSessionTool('send_session', { session_id: 'solus-peer', message: 'look', attachments: ['shot.png', join(source, 'log.txt')] }, caller)
    await sessionTools.executeSessionTool('start_session', { ...start, task: 'none', attachments: ['log.txt'] }, caller)
    expect(calls[0]!.args[2]).toMatchObject({ prompt: 'look', attachments: [join(source, 'shot.png'), join(source, 'log.txt')] })
    expect(calls[1]!.args[1]).toMatchObject({ prompt: 'build it', attachments: [join(source, 'log.txt')] })
    rmSync(source, { recursive: true, force: true })
  })

  test('send_session refuses an attachment that is not a file, and sends nothing', async () => {
    calls.length = 0
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'solus-peer', message: 'look', attachments: ['/no/such/file.txt'] }, deps())
    expect(result).toEqual({ ok: false, text: 'Attachment /no/such/file.txt is not a file on this host.' })
    expect(calls).toEqual([])
  })

  test('send_session with report off asks for nothing back', async () => {
    calls.length = 0
    await sessionTools.executeSessionTool('send_session', { session_id: 'solus-peer', message: 'fyi', report: false }, deps())
    expect(calls[0]!.args[2]).toEqual({ prompt: 'fyi', delivery: 'queue', notify: false, waitMs: 0 })
  })

  test('send_session with wait_seconds returns the report it waited for, and a reload reads it from the result', async () => {
    calls.length = 0
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'solus-peer', message: 'check', wait_seconds: 30 }, deps())
    expect(calls[0]!.args[2]).toMatchObject({ waitMs: 30_000 })
    expect(result.text).toContain('It finished while you waited')
    expect(result.text.endsWith('Reply:\nchecked')).toBe(true)
    expect(reloaded('send_session', result.text)).toEqual({
      sessionId: 'solus-peer', messageId: 'm-sent', provider: 'codex',
      report: { messageId: 'm-sent', sessionId: 'solus-peer', status: 'completed', outputs: [{ kind: 'work', workId: 'w1', title: 'Notes', workType: 'doc' }], reply: 'checked' },
    })
  })

  test('wait_seconds past the limit is refused', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('send_session', { session_id: 'solus-peer', message: 'x', wait_seconds: 601 }, deps())).ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('start_session with task=none starts a session with no task', async () => {
    // WHY: a session makes no task of its own, so the order names none.
    calls.length = 0
    const result = await sessionTools.executeSessionTool('start_session', { ...start, task: 'none', report: false }, deps())
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'spawn', args: ['solus-parent', { prompt: 'build it', provider: 'codex', modelId: 'gpt-test', cwd: '/repo', taskId: null }, false, 0, undefined] })
    expect(reloaded('start_session', result.text)).toEqual({ sessionId: 'solus-child', messageId: 'm-created', provider: 'codex' })
  })

  test('start_session with task=attempt and no task_id runs on the caller\'s own task, never a new subtask', async () => {
    // WHY: a task holds its sessions directly. A started session that minted a
    // subtask filed its works there, out of sight of the task the user opened.
    const root = await taskStore.createTask('local', { title: 'Ship the store', projectKey: '/repo', body: '' })
    await bind('solus-on-root', root.id)

    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', { ...start, task: 'attempt' }, deps('solus-on-root'))).ok).toBe(true)
    expect(calls[0]!.args[1]).toMatchObject({ taskId: root.id })
    expect(calls[0]!.args[1]).not.toHaveProperty('parentTaskId')
    expect(calls[0]!.args[2]).toBe(true)
  })

  test('start_session with task=attempt from a session with no task and no task_id is refused, not filed at the top', async () => {
    calls.length = 0
    const result = await sessionTools.executeSessionTool('start_session', { ...start, task: 'attempt' }, deps('solus-without-task'))
    expect(result.ok).toBe(false)
    expect(result.text).toContain("task='none'")
    expect(calls).toEqual([])
  })

  test('start_session with task=attempt and task_id runs on that task', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', { ...start, task: 'attempt', task_id: 'task-7' }, deps())).ok).toBe(true)
    expect(calls[0]!.args[1]).toMatchObject({ taskId: 'task-7' })
  })

  test('start_session no longer accepts task=subtask', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', { ...start, task: 'subtask' }, deps())).ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('start_session without a task choice is refused', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('start_session', start, deps())).ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('read_task_sessions shows the caller\'s own task by default, and needs a task otherwise', async () => {
    const root = await taskStore.createTask('local', { title: 'Coordinate the work', projectKey: '/repo', body: '' })
    await bind('solus-coordinator', root.id)
    const view = await sessionTools.executeSessionTool('read_task_sessions', {}, deps('solus-coordinator'))
    expect(view.ok).toBe(true)
    expect(view.text).toContain(`Task ${root.id}`)
    expect(await sessionTools.executeSessionTool('read_task_sessions', {}, deps('solus-without-task'))).toEqual({ ok: false, text: 'This session has no task. Pass task_id.' })
  })

  test('stop_session stops the target on behalf of the caller', async () => {
    calls.length = 0
    expect((await sessionTools.executeSessionTool('stop_session', { session_id: 'solus-peer' }, deps())).ok).toBe(true)
    expect(calls).toEqual([{ method: 'stop', args: ['solus-parent', 'solus-peer'] }])
  })

  test('a session cannot message itself', async () => {
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'solus-parent', message: 'hi' }, deps())
    expect(result).toEqual({ ok: false, text: 'Cannot message your own session.' })
  })

  test('the tools the redesign replaced are gone', async () => {
    expect(sessionTools.sessionAgentTools.map((tool) => tool.name)).toEqual([
      'list_agent_targets', 'search_sessions', 'read_session', 'read_session_exchange', 'read_task_sessions', 'start_session', 'send_session', 'stop_session',
    ])
    for (const retired of ['wait_for_session', 'create_session', 'prompt_session', 'find_sessions']) {
      expect((await sessionTools.executeSessionTool(retired, { session_id: 'solus-peer' }, deps())).ok).toBe(false)
    }
  })
})

// WHY: a parent following a long-running child reads it again and again. Reading
// the whole transcript each time fills the parent's context; a cursor lets it
// read only what is new, and a page must never skip a message by ending inside
// a run of messages that share one timestamp.
describe('read_session with a cursor', () => {
  const read = async (args: Record<string, unknown>) => (await sessionTools.executeSessionTool('read_session', { session_id: 'solus-peer', ...args }, deps())).text
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


test('retry keys reach both orchestration commands', async () => {
  calls.length = 0
  await sessionTools.executeSessionTool('send_session', { session_id: 'solus-peer', message: 'retry me', request_id: 'send-1' }, deps())
  expect(calls[0]!.args[2]).toMatchObject({ requestId: 'send-1', waitMs: 0, notify: true })
  await sessionTools.executeSessionTool('start_session', { ...start, task: 'none', request_id: 'start-1' }, deps())
  expect(calls[1]!.args[4]).toBe('start-1')
})

test('saved exchange reads expose a result without consuming its queued report', async () => {
  calls.length = 0
  const result = await sessionTools.executeSessionTool('read_session_exchange', { exchange_id: 'saved-result' }, deps())
  expect(result.ok).toBe(true)
  expect(result.text).toContain('settled')
  expect(result.text).toContain('Report delivery: queued')
  expect(result.text).toContain('Review passed.')
  expect(calls).toEqual([])
  expect((await sessionTools.executeSessionTool('read_session_exchange', { exchange_id: 'saved-result' }, deps('other-caller'))).ok).toBe(false)
  expect((await sessionTools.executeSessionTool('read_session_exchange', {}, deps())).ok).toBe(false)
})

test('coordination guidance is loaded with the start tool', () => {
  expect(sessionTools.startSessionAgentTool.alwaysLoad).toBe(true)
  expect(sessionTools.startSessionAgentTool.description).toContain('wait_seconds=0')
  expect(sessionTools.startSessionAgentTool.description).toContain('native subagent')
})

// WHY: a session's id is chosen before its provider starts, so a receipt
// accepted during startup already names the session a reloaded card opens. It
// links nothing yet: there is no transcript to open until the provider starts.
test('an accepted creation names its session and exchange, and links no transcript yet', async () => {
  startingReceipt = true
  try {
    const result = await sessionTools.executeSessionTool('start_session', { ...start, task: 'none' }, deps())
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Startup continues in the background')
    expect(result.text).toContain('read_session_exchange with exchange_id=m-created')
    expect(result.text).not.toContain('session://open')
    expect(result.text).toContain('Accepted session solus-child')
    expect(reloaded('start_session', result.text)).toMatchObject({ sessionId: 'solus-child', messageId: 'm-created' })
  } finally { startingReceipt = false }
})

test('a startup failure received during an explicit wait is included in the pending receipt', async () => {
  startingReceipt = true
  startupOutcome = { type: 'report', report: { messageId: 'm-created', sessionId: 'solus-child', status: 'failed', outputs: [], reply: 'Provider unavailable' } }
  try {
    const result = await sessionTools.executeSessionTool('start_session', { ...start, task: 'none', wait_seconds: 10 }, deps())
    expect(result.text).toContain('Provider startup ended')
    expect(result.text).toContain('Provider unavailable')
    expect(result.text).not.toContain('Startup continues in the background')
    expect(reloaded('start_session', result.text)?.report?.status).toBe('failed')
  } finally { startingReceipt = false; startupOutcome = undefined }
})

test('full saved replies are read in bounded pages without consuming report delivery', async () => {
  savedReply = 'a'.repeat(6000) + '\nThe unresolved issue is on the next page.'
  calls.length = 0
  try {
    const first = await sessionTools.executeSessionTool('read_session_exchange', { exchange_id: 'saved-result', reply_offset: 0 }, deps())
    expect(first.text).toContain('a'.repeat(6000))
    expect(first.text).not.toContain('The unresolved issue')
    expect(first.text).toContain('next_reply_offset: 6000')
    const second = await sessionTools.executeSessionTool('read_session_exchange', { exchange_id: 'saved-result', reply_offset: 6000 }, deps())
    expect(second.text).toContain(savedReply.slice(6000))
    expect(second.text).toContain('next_reply_offset: null')
    expect(second.text).toContain('Report delivery: queued')
    expect(calls).toEqual([])
    expect((await sessionTools.executeSessionTool('read_session_exchange', { exchange_id: 'saved-result', reply_offset: savedReply.length + 1 }, deps())).ok).toBe(false)
    expect((await sessionTools.executeSessionTool('read_session_exchange', { exchange_id: 'saved-result', reply_offset: -1 }, deps())).ok).toBe(false)
  } finally { savedReply = 'Review passed.' }
})
