import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { isLegacyModel, type NormalizedEvent, type PermissionMode } from '@solus/contracts/types'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { AcpBackend } from '@solus/server/execution/agents/acp/acp-backend'
import type { AcpTurnFailure } from '@solus/server/execution/agents/acp/acp-agent'
import { AcpRequestError } from '@solus/server/execution/agents/acp/acp-connection'
import { antigravityAgent } from '@solus/server/execution/agents/acp/antigravity'
import type { TurnSeat } from '@solus/server/execution/seats/seat-manager'
import { runToolBindingFor, setAgentToolEndpointUrl } from '@solus/server/execution/agents/tools/agent-tool-endpoint'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import { z } from 'zod'
import { acpPermissionAnswer } from '@solus/server/execution/agents/acp/acp-permissions'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { FakeAgent, FakeChild, INITIALIZE, request, settle, setup, temporaryDirectory, testAgent, type Json } from './helpers/acp-fake-agent'

describe('AcpBackend turns', () => {
  test('a first turn starts a session, streams prose and an edit, and keeps the turn in history', async () => {
    const { backend, events, exits, agents } = setup({
      'session/prompt': (_params, agent) => {
        agent.update('thread-1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking' } })
        agent.update('thread-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed ' } })
        agent.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit a.ts', kind: 'edit', status: 'pending' })
        agent.update('thread-1', { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed', content: [{ type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: 'b' }] })
        agent.update('thread-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'it.' } })
        return { stopReason: 'end_turn' }
      },
    })
    const handle = backend.startRun(request())
    await handle.runPromise

    expect(agents[0]!.methods()).toEqual(['initialize', 'authenticate', 'session/new', 'session/prompt'])
    expect(events.find((event) => event.type === 'session_init')).toMatchObject({ sessionId: 'thread-1' })
    expect(events.filter((event) => event.type === 'thinking').map((event) => event.state)).toEqual(['start', 'update', 'stop'])
    const edit = events.find((event) => event.type === 'tool_call_update' && event.toolId === 'edit-1')
    expect(edit && edit.type === 'tool_call_update' ? JSON.parse(edit.toolInput!) : null).toEqual({ file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })
    expect(events.find((event) => event.type === 'task_complete')).toMatchObject({ result: 'Fixed it.', sessionId: 'thread-1' })
    expect(exits).toEqual([{ code: 0, signal: null }])
    expect(handle.toolCallCount).toBe(1)

    const history = await backend.loadSession('thread-1')
    expect(history.map((row) => row.role)).toEqual(['user', 'reasoning', 'assistant', 'tool', 'assistant'])
    expect(history[3]).toMatchObject({ toolName: 'Edit', toolStatus: 'completed' })
    backend.shutdown()
  })

  test("a kept turn reaches session search, as Claude's and Codex's files do; a run with no session does not", async () => {
    const answer = (_params: Json | undefined, agent: FakeAgent) => {
      agent.update('thread-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed it.' } })
      return { stopReason: 'end_turn' }
    }
    const kept = setup({ 'session/prompt': answer })
    await kept.backend.startRun(request()).runPromise
    expect(kept.indexed.map((entry) => entry.threadId)).toEqual(['thread-1'])
    expect(kept.indexed[0]!.messages.map((row) => [row.role, row.content])).toEqual([['user', 'Fix the bug'], ['assistant', 'Fixed it.']])
    kept.backend.shutdown()

    const once = setup({ 'session/prompt': answer })
    await once.backend.startRun(request({ persistence: 'ephemeral' })).runPromise
    expect(once.indexed).toEqual([])
    once.backend.shutdown()
  })

  test('a second turn reuses the open connection and does not start a new session', async () => {
    const { backend, agents } = setup({ 'session/prompt': () => ({ stopReason: 'end_turn' }) })
    await backend.startRun(request()).runPromise
    await backend.startRun(request({ conversation: { kind: 'resume', threadId: 'thread-1' } })).runPromise
    expect(agents).toHaveLength(1)
    expect(agents[0]!.methods()).toEqual(['initialize', 'authenticate', 'session/new', 'session/prompt', 'session/prompt'])
    backend.shutdown()
  })

  test('a turn after a restart resumes the saved session instead of starting a new one', async () => {
    const { backend, agents } = setup({
      'session/resume': () => ({ configOptions: [] }),
      'session/prompt': () => ({ stopReason: 'end_turn' }),
    })
    await backend.startRun(request({ conversation: { kind: 'resume', threadId: 'saved-thread' } })).runPromise
    expect(agents[0]!.methods()).toEqual(['initialize', 'authenticate', 'session/resume', 'session/prompt'])
    expect(agents[0]!.received.find((message) => message.method === 'session/resume')?.params).toMatchObject({ sessionId: 'saved-thread', cwd: '/tmp' })
    backend.shutdown()
  })

  test('a fork fails with a clear error and starts no empty session, which would lose the conversation', async () => {
    const { backend, agents } = setup({ 'session/prompt': () => ({ stopReason: 'end_turn' }) })
    const handle = backend.startRun(request({ conversation: { kind: 'fork', sourceThreadId: 'thread-1' } }))
    await settle(handle.runPromise)
    await expect(handle.runPromise).rejects.toThrow('cannot fork a conversation')
    expect(agents).toHaveLength(0)
    backend.shutdown()
  })

  test('Stop cancels the prompt and reports an interrupted run', async () => {
    let releasePrompt!: () => void
    const { backend, exits, agents } = setup({
      'session/prompt': () => new Promise<Json>((resolve) => { releasePrompt = () => resolve({ stopReason: 'cancelled' }) }),
    })
    const handle = backend.startRun(request())
    while (!agents[0]?.methods().includes('session/prompt')) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(backend.cancelSession('thread-1')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(agents[0]!.methods()).toContain('session/cancel')
    releasePrompt()
    await handle.runPromise
    expect(exits).toEqual([{ code: null, signal: 'SIGINT' }])
    backend.shutdown()
  })

  test('a refused sign-in fails the run with an auth error, so the seat can ask to sign in again', async () => {
    const { backend, events } = setup({
      authenticate: () => { throw new AcpRequestError('authenticate', -32000, 'Authentication required') },
    })
    const handle = backend.startRun(request())
    await settle(handle.runPromise)
    expect(events.find((event) => event.type === 'error')).toMatchObject({ kind: 'auth', message: 'Sign in to Antigravity.' })
    await expect(handle.runPromise).rejects.toThrow('Authentication required')
  })
})

describe('AcpBackend steering', () => {
  /** An agent whose prompts each wait until the test answers them. */
  function steeringSetup(version: string) {
    const answers: Array<(stopReason: string, usage?: Json) => void> = []
    const result = setup({
      initialize: () => ({ ...(INITIALIZE as object), agentInfo: { version } }),
      'session/prompt': () => new Promise<Json>((resolve) => { answers.push((stopReason, usage) => resolve(usage ? { stopReason, usage } : { stopReason })) }),
    })
    return { ...result, answers }
  }

  async function untilPrompts(agents: FakeAgent[], count: number): Promise<void> {
    while ((agents[0]?.methods().filter((method) => method === 'session/prompt').length ?? 0) < count) await new Promise((resolve) => setTimeout(resolve, 1))
  }

  test('a message sent during a turn joins it, and the turn ends with the newest prompt', async () => {
    const { backend, events, exits, agents, answers } = steeringSetup('steers')
    const handle = backend.startRun(request())
    await untilPrompts(agents, 1)
    const steered = await backend.steerSession('thread-1', { prompt: 'Also fix the test' })
    expect(steered).toBe(handle)
    await untilPrompts(agents, 2)
    expect(agents[0]!.received.filter((message) => message.method === 'session/prompt').at(-1)?.params)
      .toMatchObject({ sessionId: 'thread-1', prompt: [{ type: 'text', text: 'Also fix the test' }] })
    // The first prompt's answer does not end a turn that a newer prompt carries on.
    answers[0]!('end_turn')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(exits).toEqual([])
    answers[1]!('end_turn')
    await handle.runPromise
    expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1)
    expect(exits).toEqual([{ code: 0, signal: null }])
    expect((await backend.loadSession('thread-1')).filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['Fix the bug', 'Also fix the test'])
    backend.shutdown()
  })

  test("a turn's tokens are the sum of its prompts' answers, steers included", async () => {
    const { backend, events, agents, answers } = steeringSetup('steers')
    const handle = backend.startRun(request())
    await untilPrompts(agents, 1)
    await backend.steerSession('thread-1', { prompt: 'Also fix the test' })
    await untilPrompts(agents, 2)
    answers[0]!('end_turn', { inputTokens: 100, outputTokens: 40, thoughtTokens: 30, cachedReadTokens: 900, totalTokens: 1040 })
    answers[1]!('end_turn', { inputTokens: 20, outputTokens: 5, thoughtTokens: 9, cachedReadTokens: 1000, cachedWriteTokens: 50, totalTokens: 1075 })
    await handle.runPromise
    // Reasoning is part of the output: a thought count above the output is cut to it.
    expect(events.find((event) => event.type === 'task_complete')).toMatchObject({
      usage: { inputTokens: 120, outputTokens: 45, reasoningTokens: 35, cacheReadTokens: 1900, cacheCreationTokens: 50 },
    })
    backend.shutdown()
  })

  test('an agy that cannot steer leaves the message for the next turn', async () => {
    const { backend, agents, answers } = steeringSetup('1.4.9')
    const handle = backend.startRun(request())
    await untilPrompts(agents, 1)
    expect(await backend.steerSession('thread-1', { prompt: 'Also fix the test' })).toBeNull()
    answers[0]!('end_turn')
    await handle.runPromise
    expect(agents[0]!.methods().filter((method) => method === 'session/prompt')).toHaveLength(1)
    backend.shutdown()
  })

  test('a message that arrives after the turn has no running prompt is not sent', async () => {
    const { backend, agents, answers } = steeringSetup('steers')
    const handle = backend.startRun(request())
    await untilPrompts(agents, 1)
    answers[0]!('end_turn')
    await handle.runPromise
    expect(await backend.steerSession('thread-1', { prompt: 'Too late' })).toBeNull()
    expect(agents[0]!.methods().filter((method) => method === 'session/prompt')).toHaveLength(1)
    backend.shutdown()
  })
})

describe('AcpBackend agent cards', () => {
  const dispatched: NormalizedEvent = {
    type: 'agent_conversation_update',
    update: { phase: 'dispatched', sessionId: 'child-1', messageId: 'exchange-1', origin: 'created', prompt: 'Pin workflow versions', provider: 'antigravity', title: 'Workflow version pinning', cwd: '/repo', fireAndForget: true, dispatchedAt: 1 },
  }

  // agy does not send back the text of a Solus tool's result, so its own
  // start_sessions row has no exchange tags, and a reload had no card.
  test('a session the turn started keeps its card after a reload', async () => {
    let answer: ((stopReason: string) => void) | undefined
    const { backend } = setup({
      initialize: () => INITIALIZE,
      'session/prompt': () => new Promise<Json>((resolve) => { answer = (stopReason) => resolve({ stopReason }) }),
    })
    const handle = backend.startRun(request())
    while (!answer) await new Promise((resolve) => setTimeout(resolve, 1))
    backend.keepHostEvent('thread-1', dispatched)
    answer('end_turn')
    await handle.runPromise

    const results = projectSessionHistory(await backend.loadSession('thread-1')).flatMap((row) => row.agentConversationResults ?? [])
    expect(results).toEqual([{ sessionId: 'child-1', messageId: 'exchange-1', provider: 'antigravity', item: 0 }])
    backend.shutdown()
  })

  test('a card update after the turn ended adds no row', async () => {
    const { backend } = setup({ initialize: () => INITIALIZE, 'session/prompt': () => ({ stopReason: 'end_turn' }) })
    await backend.startRun(request()).runPromise
    const before = await backend.loadSession('thread-1')
    backend.keepHostEvent('thread-1', dispatched)
    expect(await backend.loadSession('thread-1')).toEqual(before)
    backend.shutdown()
  })
})

describe('AcpBackend permissions', () => {
  function permissionTurn(kind: string, mode: PermissionMode) {
    const answers: Array<Json | undefined> = []
    const setupResult = setup({
      'session/prompt': async (_params, agent) => {
        answers.push(await agent.request('session/request_permission', {
          sessionId: 'thread-1',
          toolCall: { toolCallId: 'tool-1', title: 'Run it', kind },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Deny', kind: 'reject_once' },
          ],
        }))
        return { stopReason: 'end_turn' }
      },
    })
    const handle = setupResult.backend.startRun(request({ permissionMode: mode }))
    return { ...setupResult, handle, answers }
  }

  test('full access answers every request without asking', async () => {
    const { backend, handle, answers, events } = permissionTurn('execute', 'full-access')
    await handle.runPromise
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'yes' } }])
    expect(events.some((event) => event.type === 'permission_request')).toBe(false)
    backend.shutdown()
  })

  test('plan mode denies a change and records the denial', async () => {
    const { backend, handle, answers } = permissionTurn('edit', 'plan')
    await handle.runPromise
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'no' } }])
    expect(handle.permissionDenials).toEqual([{ tool_name: 'Run it', tool_use_id: 'tool-1' }])
    backend.shutdown()
  })

  test('supervised mode asks the person and sends the option they chose', async () => {
    const { backend, handle, answers, events } = permissionTurn('edit', 'supervised')
    while (!events.some((event) => event.type === 'permission_request')) await new Promise((resolve) => setTimeout(resolve, 1))
    const asked = events.find((event) => event.type === 'permission_request')
    expect(asked).toMatchObject({ toolUseId: 'tool-1', options: [{ id: 'yes', kind: 'allow' }, { id: 'no', kind: 'deny' }] })
    if (asked?.type !== 'permission_request') throw new Error('No permission request')
    expect(backend.permissions.respondToPermission(asked.questionId, 'yes')).toBe(true)
    await handle.runPromise
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'yes' } }])
    expect(handle.sawPermissionRequest).toBe(true)
    backend.shutdown()
  })

  test('the permission table: reads are free, changes follow the mode, plan denies', () => {
    expect(acpPermissionAnswer('supervised', 'read')).toBe('allow')
    expect(acpPermissionAnswer('supervised', 'edit')).toBe('ask')
    expect(acpPermissionAnswer('accept-edits', 'edit')).toBe('allow')
    expect(acpPermissionAnswer('accept-edits', 'execute')).toBe('ask')
    expect(acpPermissionAnswer('plan', 'execute')).toBe('deny')
    expect(acpPermissionAnswer('full-access', 'other')).toBe('allow')
    expect(acpPermissionAnswer('auto', undefined)).toBe('ask')
  })
})

describe('AcpBackend forms', () => {
  // agy's `ask_question` arrives as an MCP-style form: the person answers it on the same card as an MCP server's form.
  function formTurn(overrides: Partial<AgentRunRequest> = {}, form?: Json) {
    const answers: Array<Json | undefined> = []
    let initializeParams: Json | undefined
    const setupResult = setup({
      initialize: (params) => {
        initializeParams = params
        return INITIALIZE
      },
      'session/prompt': async (_params, agent) => {
        answers.push(await agent.request('elicitation/create', form ?? {
          sessionId: 'thread-1',
          mode: 'form',
          message: 'Which database?',
          requestedSchema: { type: 'object', properties: { database: { type: 'string', title: 'Database', enum: ['postgres', 'sqlite'] } }, required: ['database'] },
        }))
        return { stopReason: 'end_turn' }
      },
    })
    const handle = setupResult.backend.startRun(request(overrides))
    return { ...setupResult, handle, answers, initializeParams: () => initializeParams }
  }

  async function askedForm(events: NormalizedEvent[]) {
    while (!events.some((event) => event.type === 'question_request')) await new Promise((resolve) => setTimeout(resolve, 1))
    const asked = events.find((event) => event.type === 'question_request')
    if (asked?.type !== 'question_request') throw new Error('No question')
    return asked
  }

  test('the client tells the agent that it fills forms, and the answer goes back as the form content', async () => {
    const { backend, handle, answers, events, initializeParams } = formTurn()
    const asked = await askedForm(events)
    expect(initializeParams()).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } })
    expect(asked.kind).toBe('mcp_form')
    expect(asked.agentAnswerableForm).toEqual({ requiredFields: ['database'] })
    expect(asked.questions.map((question) => question.id)).toContain('database')
    expect(backend.permissions.respondToQuestion(asked.questionId, { database: 'sqlite' })).toBe(true)
    await handle.runPromise
    expect(answers).toEqual([{ action: 'accept', content: { database: 'sqlite' } }])
    expect(events.some((event) => event.type === 'permission_resolved' && event.questionId === asked.questionId)).toBe(true)
    backend.shutdown()
  })

  test('Antigravity accepts multiple selections and lets optional fields stay empty', async () => {
    const { backend, handle, answers, events } = formTurn({}, {
      sessionId: 'thread-1',
      mode: 'form',
      message: 'The agent has one question.',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: { type: 'array', title: 'Which databases?', items: { type: 'string', anyOf: [{ const: '1', title: 'Postgres' }, { const: '2', title: 'SQLite' }] } },
          q0_other: { type: 'string', title: 'Other' },
        },
      },
    })
    try {
      const asked = await askedForm(events)
      expect(asked.agentAnswerableForm).toEqual({ requiredFields: [] })
      expect(asked.questions[0]).toMatchObject({
        id: 'q0', multiSelect: true, options: [{ label: '1', description: 'Postgres' }, { label: '2', description: 'SQLite' }],
      })
      expect(backend.permissions.respondToQuestion(asked.questionId, { q0: '1, 2' })).toBe(true)
      await handle.runPromise
      expect(answers).toEqual([{ action: 'accept', content: { q0: ['1', '2'] } }])
    } finally { backend.shutdown() }
  })

  test('a named server form keeps its client-only response path', async () => {
    const { backend, events, handle } = formTurn({}, {
      sessionId: 'thread-1', mode: 'form', serverName: 'external',
      requestedSchema: { properties: { confirm: { type: 'boolean' } } },
    })
    try {
      const asked = await askedForm(events)
      expect(asked.agentAnswerableForm).toBeUndefined()
      expect(backend.permissions.respondToQuestion(asked.questionId, { __action: 'decline' })).toBe(true)
      await handle.runPromise
    } finally { backend.shutdown() }
  })

  test('a declined form sends only the action', async () => {
    const { backend, handle, answers, events } = formTurn()
    const asked = await askedForm(events)
    backend.permissions.respondToQuestion(asked.questionId, { __action: 'decline' })
    await handle.runPromise
    expect(answers).toEqual([{ action: 'decline' }])
    backend.shutdown()
  })

  test('nobody is there to answer an unattended run, so the form is cancelled without a card', async () => {
    const { backend, handle, answers, events } = formTurn({ unattended: true })
    await handle.runPromise
    expect(answers).toEqual([{ action: 'cancel' }])
    expect(events.some((event) => event.type === 'question_request')).toBe(false)
    backend.shutdown()
  })

  test('Stop cancels an open form', async () => {
    const { backend, handle, answers, events } = formTurn()
    await askedForm(events)
    handle.abortController.abort()
    await settle(handle.runPromise)
    expect(answers).toEqual([{ action: 'cancel' }])
    backend.shutdown()
  })
})

describe('AcpBackend turn outcome', () => {
  // agy answers `end_turn` when the API failed; the agent's own check reads what really happened.
  function failedTurn(failure: AcpTurnFailure) {
    const checked: string[] = []
    const result = setup({ 'session/prompt': () => ({ stopReason: 'end_turn' }) }, {
      agent: {
        watchTurnOutcome: (_request, threadId) => {
          checked.push(threadId)
          return () => failure
        },
      },
    })
    return { ...result, checked, handle: result.backend.startRun(request()) }
  }

  test('a limit the account reached parks the run until its reset, as a Claude or Codex limit does', async () => {
    const { backend, handle, events, exits, checked } = failedTurn({ message: 'Quota reached.', code: 'RESOURCE_EXHAUSTED', usageLimit: { resetsAt: 1_900_000_000 } })
    await handle.runPromise
    expect(checked).toEqual(['thread-1'])
    expect(events).toContainEqual({ type: 'rate_limit', status: 'limited', resetsAt: 1_900_000_000, rateLimitType: 'Antigravity', isUsingOverage: false })
    expect(events.some((event) => event.type === 'task_complete')).toBe(false)
    expect(exits).toEqual([{ code: 0, signal: null }])
    backend.shutdown()
  })

  test('another upstream error fails the run with its message, not a success', async () => {
    const { backend, handle, events, errors } = failedTurn({ message: 'Bad Gateway: Failed to connect to backend API', code: '502 Bad Gateway', usageLimit: null })
    await expect(handle.runPromise).rejects.toThrow('Bad Gateway: Failed to connect to backend API')
    expect(errors.map((error) => error.message)).toEqual(['Bad Gateway: Failed to connect to backend API'])
    expect(events.some((event) => event.type === 'task_complete')).toBe(false)
    backend.shutdown()
  })
})

describe('AcpBackend temp folders', () => {
  // agy unpacks about 1 GB into its temp folder at each launch and never removes it.
  test("each process gets its own temp folder, removed when it exits; a crash's leftovers go at the first launch", async () => {
    const tempRoot = join(temporaryDirectory(), 'tmp')
    mkdirSync(join(tempRoot, 'run-left-by-a-crash'), { recursive: true })
    mkdirSync(join(tempRoot, 'kept'))
    const { backend, spawns } = setup({ 'session/prompt': () => ({ stopReason: 'end_turn' }) }, {
      agent: { launch: () => ({ file: 'agy', args: ['acp'], env: { PATH: '/bin' }, connectionKey: 'profile', authMethod: null, tempRoot }) },
    })
    await backend.startRun(request()).runPromise
    const temp = spawns[0]!.TMPDIR!
    expect(temp.startsWith(join(tempRoot, 'run-'))).toBe(true)
    expect(spawns[0]).toMatchObject({ PATH: '/bin', TEMP: temp, TMP: temp })
    expect(existsSync(temp)).toBe(true)
    backend.shutdown()
    while (existsSync(temp) || existsSync(join(tempRoot, 'run-left-by-a-crash'))) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(readdirSync(tempRoot)).toEqual(['kept'])
  })

  test('a launch with no temp root keeps the environment as it is', async () => {
    const { backend, spawns } = setup({ 'session/prompt': () => ({ stopReason: 'end_turn' }) })
    await backend.startRun(request()).runPromise
    expect(spawns[0]!.TMPDIR).toBeUndefined()
    backend.shutdown()
  })
})

describe('AcpBackend agent commands', () => {
  // agy reports its own commands (`/plan`, `/compact`) when a session opens, before any turn: the slash menu lists them.
  test("the agent's commands reach the slash menu, and stay after a restart", async () => {
    const historyDirectory = temporaryDirectory()
    const backend = new AcpBackend({
      agent: testAgent,
      historyDirectory,
      indexMessages: () => {},
      spawnAgent: () => new FakeChild(new FakeAgent({
        initialize: () => INITIALIZE,
        authenticate: () => ({}),
        'session/new': (_params, agent) => {
          agent.update('thread-1', { sessionUpdate: 'available_commands_update', availableCommands: [
            { name: 'plan', description: 'Plan before acting', input: { hint: 'goal' } },
            { name: 'compact', description: 'Compact the context' },
          ] })
          return { sessionId: 'thread-1', configOptions: [] }
        },
        'session/prompt': () => ({ stopReason: 'end_turn' }),
      })) as unknown as ChildProcess,
    })
    expect((await backend.listPluginCommands('/tmp')).builtin).toBeUndefined()
    await backend.startRun(request()).runPromise
    const expected = [{ name: 'plan', description: 'Plan before acting', argumentHint: 'goal' }, { name: 'compact', description: 'Compact the context' }]
    expect((await backend.listPluginCommands('/tmp')).builtin).toEqual(expected)
    backend.shutdown()

    const restarted = new AcpBackend({ agent: testAgent, historyDirectory })
    expect((await restarted.listPluginCommands('/tmp')).builtin).toEqual(expected)
    restarted.shutdown()
  })
})

describe('AcpBackend reported models', () => {
  // agy offers each Google account its own models in `session/new`. They are the list: a published
  // model the account is not offered would only fail its run, and a model the list lacks still runs.
  const configOptions = [{ id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [
    { value: 'gemini-3.8-flash', name: 'gemini flash' },
    { value: 'gemini-5-preview', name: 'Gemini 5 Preview' },
  ] }]

  test("the account's offered models are the list, labelled by the published list, and stay after a restart", async () => {
    const historyDirectory = temporaryDirectory()
    const fresh = new AcpBackend({ agent: testAgent, historyDirectory })
    // Before the first session, the published list.
    expect(fresh.metadata.models.map((model) => model.id)).toContain('gemini-4-hydrogen')
    expect(fresh.metadata.modelsOffered).toBeUndefined()
    fresh.shutdown()

    const backend = new AcpBackend({
      agent: testAgent,
      historyDirectory,
      indexMessages: () => {},
      spawnAgent: () => new FakeChild(new FakeAgent({
        initialize: () => INITIALIZE,
        authenticate: () => ({}),
        'session/new': () => ({ sessionId: 'thread-1', configOptions }),
        'session/prompt': () => ({ stopReason: 'end_turn' }),
      })) as unknown as ChildProcess,
    })
    let reports = 0
    backend.on('models-reported', () => { reports += 1 })
    await backend.startRun(request()).runPromise
    expect(reports).toBe(1)
    expect(backend.metadata).toMatchObject({
      models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }, { id: 'gemini-5-preview', label: 'Gemini 5 Preview' }],
      // The published default is not offered, so the first offered model is.
      defaultModel: 'gemini-3.8-flash',
      modelsOffered: true,
    })
    expect(backend.metadata.modelProfiles?.['gemini-3.8-flash']?.reasoningLevels).toEqual(['low', 'medium', 'high'])
    expect(backend.metadata.modelProfiles?.['gemini-5-preview']).toMatchObject({ label: 'Gemini 5 Preview', reasoningLevels: [] })
    expect(backend.metadata.modelProfiles?.['gemini-4-hydrogen']).toBeUndefined()
    backend.shutdown()

    const restarted = new AcpBackend({ agent: testAgent, historyDirectory })
    expect(restarted.metadata.models.map((model) => model.id)).toEqual(['gemini-3.8-flash', 'gemini-5-preview'])
    restarted.shutdown()
  })

  test('a model refresh reads the offered models with no turn, then stops the agent', async () => {
    // WHY: agy reports the account's models only when a session opens. A new
    // plan on the account (Pro, say) must show without a person opening one.
    const { backend, agents } = setup({ 'session/new': () => ({ sessionId: 'thread-1', configOptions }) })
    let reports = 0
    backend.on('models-reported', () => { reports += 1 })
    await Promise.all([backend.refreshModels(), backend.refreshModels()])
    expect(agents).toHaveLength(1)
    expect(agents[0]!.methods()).toEqual(['initialize', 'authenticate', 'session/new'])
    expect(reports).toBe(1)
    expect(backend.metadata.models.map((model) => model.id)).toEqual(['gemini-3.8-flash', 'gemini-5-preview'])
    // The agent process ends with the refresh: no session, no idle connection.
    expect(agents[0]!.stdout.writableEnded).toBe(true)
    backend.shutdown()
  })

  test('a model refresh the agent never answers ends with an error and keeps the last list', async () => {
    const timers: Array<() => void> = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if (ms === 60_000) { timers.push(handler); return { unref() {} } as unknown as ReturnType<typeof setTimeout> }
      return realSetTimeout(handler, ms)
    }) as typeof setTimeout
    try {
      const { backend } = setup({ 'session/new': () => new Promise<Json>(() => {}) })
      const refresh = backend.refreshModels()
      await Bun.sleep(0)
      expect(timers).toHaveLength(1)
      timers[0]!()
      await expect(refresh).rejects.toThrow('did not report its models')
      expect(backend.metadata.modelsOffered).toBeUndefined()
      backend.shutdown()
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test('a model the account does not offer fails the run with a clear message; an older id of an offered model runs', async () => {
    const run = async (model: string) => {
      const { backend, agents } = setup({ 'session/new': () => ({ sessionId: 'thread-1', configOptions }), 'session/set_model': () => ({}), 'session/prompt': () => ({ stopReason: 'end_turn' }) })
      const handle = backend.startRun(request({ model }))
      await settle(handle.runPromise)
      backend.shutdown()
      return { handle, methods: agents[0]!.methods() }
    }
    const refused = await run('gemini-4-argon')
    await expect(refused.handle.runPromise).rejects.toThrow('Antigravity does not offer the model gemini-4-argon to this account. Choose another model.')
    expect(refused.methods).not.toContain('session/prompt')
    const legacy = await run('gemini-3.8-flash-high')
    expect(legacy.methods).toContain('session/set_model')
    expect(legacy.methods).toContain('session/prompt')
  })

  // What agy 1.5.18 answers a Pro account: the model option names each model once,
  // and `availableModels` names each effort of a model as its own id.
  const proSetup = {
    sessionId: 'thread-1',
    configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-4-carbon', options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
        { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      ] },
      { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high', options: [
        { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' },
      ] },
    ],
    models: { availableModels: ['gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low', 'gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-4-carbon-low', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-high', 'gemini-pro-orchestrator', 'gemini-pro-orchestrator-neon'].map((modelId) => ({ modelId })) },
  }

  test('each offered model gets the efforts agy lists for it', async () => {
    // WHY: agy gives a model's levels in its thinking option only while that
    // model is selected, so a Pro model such as Neon showed no reasoning at all.
    const { backend } = setup({ 'session/new': () => proSetup })
    await backend.refreshModels()
    const levels = (id: string) => backend.metadata.modelProfiles?.[id]?.reasoningLevels
    expect(levels('gemini-4-neon')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(levels('gemini-4-carbon')).toEqual(['low', 'medium', 'high'])
    // agy's levels win over the published ones; a default it does not offer falls back.
    expect(levels('gemini-4-hydrogen')).toEqual(['low', 'high'])
    expect(backend.metadata.modelProfiles?.['gemini-4-hydrogen']?.defaultReasoningEffort).toBe('high')
    // An orchestrator has no efforts; another model's id that starts with its own is not one.
    expect(levels('gemini-pro-orchestrator')).toEqual([])
    backend.shutdown()
  })

  test('an offered model the published list calls legacy goes under Legacy, as in T3 Code', async () => {
    // WHY: agy names no legacy models; the published list does, by exact id.
    const { backend } = setup({ 'session/new': () => ({ sessionId: 'thread-1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
      { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
    ] }] }) })
    await backend.refreshModels()
    expect(isLegacyModel('antigravity', 'gemini-3.7-flash', backend.metadata.modelProfiles)).toBe(true)
    expect(isLegacyModel('antigravity', 'gemini-3.7-flash-high', backend.metadata.modelProfiles)).toBe(true)
    expect(isLegacyModel('antigravity', 'gemini-3.8-flash', backend.metadata.modelProfiles)).toBe(false)
    backend.shutdown()
  })

  test("switching to a model sends its effort, even one the previous model's options lacked", async () => {
    // WHY: agy sends the new model's options only after it answers set_model,
    // and resets the level, so Extra on Neon was dropped in a Carbon session.
    const { backend, agents } = setup({ 'session/new': () => proSetup, 'session/set_model': () => ({}), 'session/set_config_option': () => ({}), 'session/prompt': () => ({ stopReason: 'end_turn' }) })
    await backend.startRun(request({ model: 'gemini-4-neon', reasoningEffort: 'xhigh' })).runPromise
    const sent = agents[0]!.received.filter((message) => message.method?.startsWith('session/set_'))
    expect(sent.map((message) => [message.method, message.params])).toEqual([
      ['session/set_model', { sessionId: 'thread-1', modelId: 'gemini-4-neon' }],
      ['session/set_config_option', { sessionId: 'thread-1', configId: 'thought_level', value: 'xhigh' }],
    ])
    backend.shutdown()
  })
})

describe('AcpBackend Solus tools', () => {
  // agy reaches a run's Solus tools on the host's /mcp endpoint. ACP gives MCP servers only at session/new or a resume,
  // so the session keeps one token and each turn binds its own tools to it.
  const echo: AgentTool = { name: 'echo', description: 'Echo the text.', inputFields: { text: z.string() }, requiresApproval: false, execute: async (input) => ({ ok: true, text: String(input.text) }) }
  beforeAll(() => setAgentToolEndpointUrl('http://127.0.0.1:1/mcp'))

  const mcpServersOf = (agent: FakeAgent, method: string) => {
    const params = agent.received.find((message) => message.method === method)?.params as { mcpServers?: Array<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> }
    return params.mcpServers ?? []
  }

  test("a run's tools reach agy as the Solus MCP server, and each turn binds its own tools to the session's one token", async () => {
    const seen: Array<string[] | undefined> = []
    const tokenOf = (agent: FakeAgent) => mcpServersOf(agent, 'session/new')[0]!.headers.find((header) => header.name === 'Authorization')!.value.replace(/^Bearer /, '')
    const { backend, agents } = setup({
      'session/resume': () => ({ configOptions: [] }),
      // What agy reaches with the token it was given, while the turn runs.
      'session/prompt': (_params, agent) => {
        const method = agent.received.some((message) => message.method === 'session/resume') ? 'session/resume' : 'session/new'
        const token = mcpServersOf(agent, method)[0]!.headers.find((header) => header.name === 'Authorization')!.value.replace(/^Bearer /, '')
        seen.push(runToolBindingFor(token)?.tools.map((tool) => tool.name))
        return { stopReason: 'end_turn' }
      },
    })
    await backend.startRun(request({ tools: [echo] }), { sessionId: 'solus-session-1' }).runPromise
    expect(mcpServersOf(agents[0]!, 'session/new')[0]).toMatchObject({ name: 'solus', url: 'http://127.0.0.1:1/mcp' })
    const token = tokenOf(agents[0]!)
    // Between turns the token reaches no tools.
    expect(runToolBindingFor(token)).toBeUndefined()

    // Same tool set reuses the warm connection and rebinds the session's one token.
    await backend.startRun(request({ tools: [{ ...echo }], conversation: { kind: 'resume', threadId: 'thread-1' } }), { sessionId: 'solus-session-1' }).runPromise
    expect(agents).toHaveLength(1)

    // A changed tool set (such as an MCP server installed while the session is open) reopens with session/resume so agy re-lists tools.
    const paperTool: AgentTool = { ...echo, name: 'paper__get_basic_info' }
    await backend.startRun(request({ tools: [echo, paperTool], conversation: { kind: 'resume', threadId: 'thread-1' } }), { sessionId: 'solus-session-1' }).runPromise
    expect(agents).toHaveLength(2)
    expect(mcpServersOf(agents[1]!, 'session/resume')[0]).toMatchObject({ name: 'solus', url: 'http://127.0.0.1:1/mcp' })
    expect(seen).toEqual([['echo'], ['echo'], ['echo', 'paper__get_basic_info']])
    backend.shutdown()
  })

  test('Antigravity receives the Solus MCP server even when agy omits mcpCapabilities from initialize', async () => {
    const noMcpCapabilities: Json = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [{ id: 'oauth-personal' }],
    }
    const { backend, agents } = setup({
      initialize: () => noMcpCapabilities,
      'session/prompt': () => ({ stopReason: 'end_turn' }),
    }, { agent: { acceptsHttpMcp: antigravityAgent.acceptsHttpMcp } })
    await backend.startRun(request({ tools: [echo] }), { sessionId: 'solus-session-agy-mcp' }).runPromise
    expect(mcpServersOf(agents[0]!, 'session/new').map((server) => server.name)).toEqual(['solus'])
    backend.shutdown()
  })

  test('MCP integration instructions reach session/new systemPrompt alongside user instructions', async () => {
    let seenSystemPrompt: string | undefined
    const { backend } = setup({
      'session/prompt': () => ({ stopReason: 'end_turn' }),
    }, {
      agent: {
        sessionMeta: (_init, systemPrompt) => {
          seenSystemPrompt = systemPrompt
          return undefined
        },
      },
    })
    await backend.startRun(request({
      tools: [echo],
      systemPrompt: 'Base instructions.',
      integrationInstructions: [{ name: 'paper', slug: 'paper', text: 'Call paper__get_basic_info first.' }],
    }), { sessionId: 'solus-session-instructions' }).runPromise
    expect(seenSystemPrompt).toContain('Base instructions.')
    expect(seenSystemPrompt).toContain('### paper (tools `paper__*`)')
    expect(seenSystemPrompt).toContain('Call paper__get_basic_info first.')
    backend.shutdown()
  })

  test('deferred-proxy sessions keep a warm connection when MCP servers are added and deliver their instructions once', async () => {
    const seenPrompts: string[] = []
    const seenDeferProxy: Array<boolean | undefined> = []
    const { backend, agents } = setup({
      'session/prompt': (params, agent) => {
        const blocks = (params as { prompt?: Array<{ text?: string }> })?.prompt ?? []
        seenPrompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        const token = mcpServersOf(agent, 'session/new')[0]!.headers.find((header) => header.name === 'Authorization')!.value.replace(/^Bearer /, '')
        seenDeferProxy.push(runToolBindingFor(token)?.deferProxy)
        return { stopReason: 'end_turn' }
      },
    }, { agent: { deferToolsProxy: true } })

    await backend.startRun(request({ tools: [echo], prompt: 'First turn' }), { sessionId: 'solus-session-proxy' }).runPromise
    const paperTool: AgentTool = { ...echo, name: 'paper__get_basic_info' }
    await backend.startRun(request({
      tools: [echo, paperTool],
      prompt: 'Use paper',
      integrationInstructions: [{ name: 'paper', slug: 'paper', text: 'Paper guide.' }],
      conversation: { kind: 'resume', threadId: 'thread-1' },
    }), { sessionId: 'solus-session-proxy' }).runPromise
    await backend.startRun(request({
      tools: [echo, paperTool],
      prompt: 'Third turn',
      integrationInstructions: [{ name: 'paper', slug: 'paper', text: 'Paper guide.' }],
      conversation: { kind: 'resume', threadId: 'thread-1' },
    }), { sessionId: 'solus-session-proxy' }).runPromise

    expect(agents).toHaveLength(1)
    expect(seenDeferProxy).toEqual([true, true, true])
    expect(seenPrompts[1]).toContain('### paper (tools `paper__*`)')
    expect(seenPrompts[2]).not.toContain('### paper (tools `paper__*`)')

    // Ephemeral utility runs (like text generation) do not wrap their tools in the deferred proxy.
    let ephemeralProxy: boolean | undefined
    const ephemeral = setup({
      'session/prompt': (_params, agent) => {
        const token = mcpServersOf(agent, 'session/new')[0]!.headers.find((header) => header.name === 'Authorization')!.value.replace(/^Bearer /, '')
        ephemeralProxy = runToolBindingFor(token)?.deferProxy
        return { stopReason: 'end_turn' }
      },
    }, { agent: { deferToolsProxy: true } })
    await ephemeral.backend.startRun(request({ tools: [echo], persistence: 'ephemeral' })).runPromise
    expect(ephemeralProxy).toBe(false)
    backend.shutdown()
    ephemeral.backend.shutdown()
  })

  test('non-destructive Solus MCP tools and tool_search auto-allow in plan and auto modes while destructive tools still follow the mode', async () => {
    const readTool: AgentTool = { ...echo, name: 'paper__get_basic_info', requiresApproval: false }
    const deleteTool: AgentTool = { ...echo, name: 'paper__delete_all', requiresApproval: true }
    const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
    const answers: Array<Json | undefined> = []
    const { backend } = setup({
      'session/prompt': async (_params, agent) => {
        answers.push(await agent.request('session/request_permission', {
          sessionId: 'thread-1',
          toolCall: { toolCallId: 'c1', title: 'Run mcp_solus_tool_search', kind: 'other', rawInput: { query: 'paper' } },
          options,
        }))
        answers.push(await agent.request('session/request_permission', {
          sessionId: 'thread-1',
          toolCall: { toolCallId: 'c2', title: 'Run mcp_solus_tool_call', kind: 'other', rawInput: { name: 'paper__get_basic_info', arguments: {} } },
          options,
        }))
        answers.push(await agent.request('session/request_permission', {
          sessionId: 'thread-1',
          toolCall: { toolCallId: 'c3', title: 'Run mcp_solus_tool_call', kind: 'other', rawInput: { name: 'paper__delete_all', arguments: {} } },
          options,
        }))
        return { stopReason: 'end_turn' }
      },
    }, { agent: { nameTool: antigravityAgent.nameTool } })

    await backend.startRun(request({ tools: [readTool, deleteTool], permissionMode: 'plan' })).runPromise
    expect(answers).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow' } },
      { outcome: { outcome: 'selected', optionId: 'allow' } },
      { outcome: { outcome: 'selected', optionId: 'deny' } },
    ])
    backend.shutdown()
  })

  test('a connection opened with no tools is opened again when a run brings them, and resumes the session', async () => {
    const { backend, agents } = setup({ 'session/resume': () => ({ configOptions: [] }), 'session/prompt': () => ({ stopReason: 'end_turn' }) })
    await backend.startRun(request(), { sessionId: 'solus-session-2' }).runPromise
    await backend.startRun(request({ tools: [echo], conversation: { kind: 'resume', threadId: 'thread-1' } }), { sessionId: 'solus-session-2' }).runPromise
    expect(agents).toHaveLength(2)
    expect(mcpServersOf(agents[1]!, 'session/resume').map((server) => server.name)).toEqual(['solus'])
    backend.shutdown()
  })
})

describe('AcpBackend file reads', () => {
  test("a read Solus served completes the agent's open read, which agy would fail with a later unrelated error", async () => {
    const root = temporaryDirectory()
    writeFileSync(join(root, 'README.md'), 'hello')
    const { backend, events } = setup({
      'session/prompt': async (_params, agent) => {
        agent.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Running client_view_file', kind: 'read', status: 'in_progress', locations: [{ path: join(root, 'README.md') }] })
        await agent.request('fs/read_text_file', { sessionId: 'thread-1', path: join(root, 'README.md') })
        agent.update('thread-1', { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'failed', rawOutput: 'step error: unrelated' })
        return { stopReason: 'end_turn' }
      },
    }, { agent: { isClientRead: (title) => title === 'Running client_view_file' } })
    await backend.startRun(request({ cwd: root })).runPromise
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([{ type: 'tool_result', toolUseId: 'read-1', content: '', isError: false }])
    backend.shutdown()
  })

  test('the agent reads files inside the session folders only', async () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'one\ntwo\nthree')
    const outside = join(temporaryDirectory(), 'secret.txt')
    writeFileSync(outside, 'secret')
    const reads: Array<Json | undefined> = []
    const { backend } = setup({
      'session/prompt': async (_params, agent) => {
        reads.push(await agent.request('fs/read_text_file', { sessionId: 'thread-1', path: join(root, 'src', 'a.ts'), line: 2, limit: 1 }))
        reads.push(await agent.request('fs/read_text_file', { sessionId: 'thread-1', path: outside }))
        return { stopReason: 'end_turn' }
      },
    })
    await backend.startRun(request({ cwd: root })).runPromise
    expect(reads[0]).toEqual({ content: 'two' })
    expect(reads[1]).toMatchObject({ message: 'This file is outside the session folders.' })
    backend.shutdown()
  })
})

describe('Antigravity codebase folders', () => {
  test('an approved attachment becomes readable through Solus during the same turn', async () => {
    const attached = temporaryDirectory()
    const path = join(attached, 'file.txt')
    writeFileSync(path, 'attached file')
    const reads: Array<Json | undefined> = []
    let granted = false
    const { backend } = setup({
      'session/prompt': async (_params, agent) => {
        reads.push(await agent.request('fs/read_text_file', { sessionId: 'thread-1', path }))
        granted = true
        reads.push(await agent.request('fs/read_text_file', { sessionId: 'thread-1', path }))
        return { stopReason: 'end_turn' }
      },
    })
    backend.useSessionFolders({ grantedFolderOf: (sessionId, target) => granted && sessionId === 'solus-session' && target === path ? attached : null })

    try {
      await backend.startRun(request({ cwd: temporaryDirectory() }), { sessionId: 'solus-session' }).runPromise
      expect(reads[0]).toMatchObject({ message: 'This file is outside the session folders.' })
      expect(reads[1]).toEqual({ content: 'attached file' })
    } finally {
      backend.shutdown()
    }
  })

  test('the workspace uses the granted worktrees and refreshes on resume when the folders change', async () => {
    const primary = temporaryDirectory()
    const secondary = temporaryDirectory()
    const attached = temporaryDirectory()
    const otherHostPath = '/other-host/repo'
    const seat = { home: temporaryDirectory(), launch: { env: { PATH: '/bin' } } } as TurnSeat
    const { backend, agents, argumentsOfSpawns } = setup({
      'session/resume': () => ({ configOptions: [] }),
      'session/prompt': () => ({ stopReason: 'end_turn' }),
    }, { agent: { launch: antigravityAgent.launch } })
    const workingDirectory = { name: 'frontend', path: primary, state: 'git' } as const
    const folder = { name: 'backend', path: secondary, state: 'git' } as const
    const run = request({
      cwd: primary,
      seat,
      additionalDirectories: [secondary, primary, secondary],
      codebase: { name: 'App', workingDirectory, folders: [folder], otherHosts: [{ name: 'remote', host: 'Build host', path: otherHostPath }] },
    })
    const resume = { kind: 'resume', threadId: 'thread-1' } as const
    const addedFolder = { name: 'docs', path: attached, state: 'plain' } as const

    try {
      await backend.startRun(run).runPromise
      expect(argumentsOfSpawns[0]?.slice(-2)).toEqual(['--add-dir', secondary])
      expect(argumentsOfSpawns[0]).not.toContain(otherHostPath)
      const firstPrompt = JSON.stringify(agents[0]?.received.find(({ method }) => method === 'session/prompt')?.params)
      expect(firstPrompt).toContain('<codebase')
      expect(firstPrompt).toContain(secondary)
      expect(firstPrompt).toContain(otherHostPath)

      await backend.startRun({ ...run, conversation: resume, additionalDirectories: [primary, secondary] }).runPromise
      expect(agents).toHaveLength(1)

      await backend.startRun({
        ...run,
        conversation: resume,
        additionalDirectories: [attached, secondary],
        codebase: { name: 'App', workingDirectory, folders: [folder, addedFolder], otherHosts: [] },
      }).runPromise
      expect(agents).toHaveLength(2)
      expect(argumentsOfSpawns[1]?.slice(-4)).toEqual([attached, secondary].sort().flatMap((path) => ['--add-dir', path]))
      expect(agents[1]?.received.find(({ method }) => method === 'session/resume')?.params).toMatchObject({ sessionId: 'thread-1', cwd: primary })
      const resumedPrompt = JSON.stringify(agents[1]?.received.find(({ method }) => method === 'session/prompt')?.params)
      expect(resumedPrompt).toContain(attached)
      expect(resumedPrompt).not.toContain(otherHostPath)

      await backend.startRun({ ...run, conversation: resume, additionalDirectories: [], codebase: undefined }).runPromise
      expect(agents).toHaveLength(3)
      expect(argumentsOfSpawns[2]).not.toContain('--add-dir')
      expect(agents[2]?.received.find(({ method }) => method === 'session/prompt')?.params).toMatchObject({ prompt: [{ type: 'text', text: run.prompt }] })
      expect((await backend.loadSession('thread-1'))[0]?.content).toBe('Fix the bug')
    } finally {
      backend.shutdown()
    }
  })
})
