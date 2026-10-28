import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { AgentRunRequest, ProviderConversation } from '@solus/server/execution/agents/agent-runner'
import type { ReplayClock } from '@solus/server/execution/agents/replay/replay-backend'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { ReplayBackend, REPLAY_CHUNK_DELAY_MS, REPLAY_EVENT_DELAY_MS, REPLAY_MAX_RECORDED_DELAY_MS } = await import('@solus/server/execution/agents/replay/replay-backend')
const { loadReplayScenarios, parseReplayScenario, streamChunks } = await import('@solus/server/execution/agents/replay/replay-scenario')
const { replayBackendAllowed } = await import('@solus/server/execution/agents/replay/replay-gate')

const SCENARIO_DIR = resolve(import.meta.dir, '../../packages/server/src/execution/agents/replay/scenarios')
const directories: string[] = []
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-replay-test-'))
  directories.push(directory)
  return directory
}

/** Waits for nothing, and remembers each wait the stream asked for. */
function instantClock(): ReplayClock & { waits: number[] } {
  const waits: number[] = []
  return { waits, sleep: async (ms) => { waits.push(ms) } }
}

const TWO_TURNS = [
  '{"kind":"scenario","label":"Two turns"}',
  '{"kind":"turn"}',
  '{"kind":"event","event":{"type":"tool_call","toolName":"Read","toolId":"read-1","index":0,"toolInput":"{\\"file_path\\":\\"<workspace>/a.ts\\"}"}}',
  '{"kind":"event","event":{"type":"text_chunk","text":"first turn"}}',
  '{"kind":"turn"}',
  '{"kind":"event","event":{"type":"text_chunk","text":"second turn"}}',
].join('\n')

function backendWith(scenarioTexts: Record<'two-turns', string> | null = null, clock = instantClock()) {
  const scenarios = scenarioTexts
    ? [parseReplayScenario('two-turns', scenarioTexts['two-turns'])]
    : loadReplayScenarios(SCENARIO_DIR)
  return { backend: new ReplayBackend({ scenarios, historyDirectory: temporaryDirectory(), clock }), clock }
}

type Backend = InstanceType<typeof ReplayBackend>

interface PlayedRun {
  nativeSessionId: string | null
  events: NormalizedEvent[]
  exit: { code: number | null; signal: string | null } | null
  error: Error | null
}

/** Starts one run and collects what it emits until it exits or fails. */
function play(
  backend: Backend,
  options: { prompt?: string; model?: string; cwd?: string; conversation?: ProviderConversation; onEvent?: (event: NormalizedEvent, handleId: string | null) => void } = {},
): Promise<PlayedRun> {
  const request: AgentRunRequest = {
    provider: 'replay',
    prompt: options.prompt ?? 'go',
    cwd: options.cwd ?? '/work/project',
    tools: [],
    model: options.model ?? 'two-turns',
    permissionMode: 'supervised',
    persistence: 'session',
    service: 'sessions',
    conversation: options.conversation,
  }
  return new Promise((resolveRun) => {
    const run: PlayedRun = { nativeSessionId: null, events: [], exit: null, error: null }
    const belongs = (sessionId: string | null) => sessionId === handle.agentSessionId || (sessionId === null && run.nativeSessionId === null)
    const onNormalized = (sessionId: string | null, event: NormalizedEvent) => {
      if (event.type === 'session_init' && run.nativeSessionId === null && handle.agentSessionId === event.sessionId) run.nativeSessionId = event.sessionId
      if (!belongs(sessionId)) return
      run.events.push(event)
      options.onEvent?.(event, sessionId)
    }
    const finish = () => {
      backend.off('normalized', onNormalized)
      backend.off('exit', onExit)
      backend.off('error', onError)
      resolveRun(run)
    }
    const onExit = (sessionId: string | null, code: number | null, signal: string | null) => {
      if (!belongs(sessionId)) return
      run.exit = { code, signal }
      finish()
    }
    const onError = (_sessionId: string | null, error: Error) => {
      run.error = error
      finish()
    }
    backend.on('normalized', onNormalized)
    backend.on('exit', onExit)
    backend.on('error', onError)
    const handle = backend.startRun(request, { sessionId: 'solus-session' })
    void handle.runPromise.catch(() => {})
  })
}

const texts = (events: NormalizedEvent[]) => events.flatMap((event) => event.type === 'text_chunk' ? [event.text] : [])

describe('replay scenarios', () => {
  test('a file splits into turns at each turn marker', () => {
    const scenario = parseReplayScenario('two-turns', TWO_TURNS)
    expect(scenario.label).toBe('Two turns')
    expect(scenario.turns.map((turn) => turn.map((step) => step.event.type))).toEqual([['tool_call', 'text_chunk'], ['text_chunk']])
  })

  test('a file may not hold lifecycle events, which the backend owns', () => {
    const withLifecycle = `${TWO_TURNS}\n{"kind":"event","event":{"type":"task_complete","result":"","costUsd":0,"durationMs":0,"numTurns":1,"usage":{},"sessionId":"x"}}`
    expect(() => parseReplayScenario('bad', withLifecycle)).toThrow('line 7')
  })

  test('every committed scenario parses, and showcase is the default', () => {
    const scenarios = loadReplayScenarios(SCENARIO_DIR)
    expect(scenarios[0]!.id).toBe('showcase')
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(['codex-command', 'codex-plan', 'showcase', 'subagent'])
  })

  test('text streams in chunks of about three words that join back to the recorded text', () => {
    const text = 'One two three four five six seven.\n\n| a | b |\n```ts\nconst x = 1\n```'
    const chunks = streamChunks(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.length).toBeGreaterThan(3)
    for (const chunk of chunks) expect(chunk.trim().split(/\s+/).length).toBeLessThanOrEqual(3)
  })
})

describe('ReplayBackend', () => {
  test('lists its scenarios as models, under the Replay (dev) label', () => {
    const { backend } = backendWith()
    expect(backend.metadata.label).toBe('Replay (dev)')
    expect(backend.metadata.defaultModel).toBe('showcase')
    expect(backend.metadata.available).toBe(true)
    expect(backend.metadata.models.map((model) => model.id)).toContain('subagent')
  })

  test('an unknown scenario fails the run with a clear error and plays nothing', async () => {
    const { backend } = backendWith()
    const run = await play(backend, { model: 'no-such-scenario' })
    expect(run.error?.message).toContain('Unknown replay scenario "no-such-scenario"')
    expect(run.events).toEqual([])
  })

  test('each prompt plays the next turn and wraps around, with fresh tool ids each time', async () => {
    const { backend } = backendWith({ 'two-turns': TWO_TURNS })
    const first = await play(backend, { cwd: '/work/project' })
    const threadId = first.nativeSessionId!
    const resume = { kind: 'resume', threadId } as const
    const second = await play(backend, { conversation: resume })
    const third = await play(backend, { conversation: resume })

    expect(texts(first.events).join('')).toBe('first turn')
    expect(texts(second.events).join('')).toBe('second turn')
    expect(texts(third.events).join('')).toBe('first turn')
    const firstRead = first.events.find((event) => event.type === 'tool_call')
    const thirdRead = third.events.find((event) => event.type === 'tool_call')
    expect(firstRead?.type === 'tool_call' && firstRead.toolInput).toBe('{"file_path":"/work/project/a.ts"}')
    expect(firstRead?.type === 'tool_call' && thirdRead?.type === 'tool_call' && firstRead.toolId !== thirdRead.toolId).toBe(true)
    expect(first.exit).toEqual({ code: 0, signal: null })
    expect(first.events.at(-1)).toMatchObject({ type: 'task_complete', result: 'first turn', sessionId: threadId })
  })

  test('two sessions keep their own place in the scenario', async () => {
    const { backend } = backendWith({ 'two-turns': TWO_TURNS })
    const sessionA = await play(backend)
    const sessionB = await play(backend)
    expect(sessionA.nativeSessionId).not.toBe(sessionB.nativeSessionId)
    expect(texts(sessionB.events).join('')).toBe('first turn')
    const sessionAAgain = await play(backend, { conversation: { kind: 'resume', threadId: sessionA.nativeSessionId! } })
    expect(texts(sessionAAgain.events).join('')).toBe('second turn')
  })

  test('streaming waits about 30 ms per chunk, 250 ms between events, and caps a recorded delay at 2 s', async () => {
    const recorded = ['{"kind":"scenario","label":"Paced"}', '{"kind":"turn"}',
      '{"kind":"event","event":{"type":"usage"},"afterMs":60000}',
      '{"kind":"event","event":{"type":"progress","todos":[]}}',
      '{"kind":"event","event":{"type":"text_chunk","text":"one two three four"}}'].join('\n')
    const clock = instantClock()
    const { backend } = backendWith({ 'two-turns': recorded }, clock)
    await play(backend)
    expect(clock.waits).toEqual([REPLAY_MAX_RECORDED_DELAY_MS, REPLAY_EVENT_DELAY_MS, REPLAY_CHUNK_DELAY_MS, REPLAY_CHUNK_DELAY_MS])
  })

  test('an allowed permission lets the showcase run to its final answer', async () => {
    const { backend } = backendWith()
    const run = await play(backend, {
      model: 'showcase',
      onEvent: (event) => {
        if (event.type === 'permission_request') expect(backend.permissions.respondToPermission(event.questionId, 'allow')).toBe(true)
      },
    })
    const text = texts(run.events).join('')
    expect(text).toContain('## Done')
    expect(text).toContain('| Input | Range | Result |')
    expect(run.events.some((event) => event.type === 'tool_result' && event.content.includes('3 pass'))).toBe(true)
    expect(run.events.at(-1)).toMatchObject({ type: 'task_complete', permissionDenials: [] })
    expect(run.exit).toEqual({ code: 0, signal: null })
  })

  test('a denied permission fails the tool and ends the turn there', async () => {
    const { backend } = backendWith()
    const run = await play(backend, {
      model: 'showcase',
      onEvent: (event) => {
        if (event.type === 'permission_request') backend.permissions.respondToPermission(event.questionId, 'deny')
      },
    })
    const request = run.events.find((event) => event.type === 'permission_request')
    const toolUseId = request?.type === 'permission_request' ? request.toolUseId! : ''
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'tool_call_complete', toolId: toolUseId, outcome: { status: 'failed', declined: true } }))
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'tool_result', toolUseId, isError: true }))
    expect(texts(run.events).join('')).not.toContain('## Done')
    expect(run.events.at(-1)).toMatchObject({ type: 'task_complete', permissionDenials: [{ toolName: 'Edit', toolUseId }] })
    expect(run.exit).toEqual({ code: 0, signal: null })
  })

  test('Stop while a permission waits ends the turn as interrupted, with no result', async () => {
    const { backend } = backendWith()
    const run = await play(backend, {
      model: 'showcase',
      onEvent: (event, sessionId) => {
        if (event.type === 'permission_request') queueMicrotask(() => backend.cancelSession(sessionId!))
      },
    })
    expect(run.exit).toEqual({ code: null, signal: 'SIGINT' })
    expect(run.events.some((event) => event.type === 'task_complete')).toBe(false)
    expect(backend.isSessionRunning(run.nativeSessionId!)).toBe(false)
  })

  test('the second showcase turn waits for the question to be answered', async () => {
    const { backend } = backendWith()
    const allow = (event: NormalizedEvent) => {
      if (event.type === 'permission_request') backend.permissions.respondToPermission(event.questionId, 'allow')
    }
    const first = await play(backend, { model: 'showcase', onEvent: allow })
    let asked = false
    const second = await play(backend, {
      model: 'showcase',
      conversation: { kind: 'resume', threadId: first.nativeSessionId! },
      onEvent: (event) => {
        if (event.type !== 'question_request') return
        asked = true
        expect(backend.permissions.respondToQuestion(event.questionId, { Range: 'Swap them' })).toBe(true)
      },
    })
    expect(asked).toBe(true)
    expect(texts(second.events).join('')).toContain('Thanks.')
  })

  test('a reopened session reads its history back, a page of turns at a time', async () => {
    const { backend } = backendWith({ 'two-turns': TWO_TURNS })
    const first = await play(backend, { prompt: 'hello' })
    await play(backend, { prompt: 'again', conversation: { kind: 'resume', threadId: first.nativeSessionId! } })
    const page = await backend.loadSessionPage(first.nativeSessionId!, undefined, 1)
    expect(page.messages.map((message) => [message.role, message.content])).toEqual([['user', 'again'], ['assistant', 'second turn']])
    const older = await backend.loadSessionPage(first.nativeSessionId!, undefined, 1, page.before!)
    expect(older.messages.map((message) => message.role)).toEqual(['user', 'tool', 'assistant'])
    expect(older.before).toBeNull()
  })
})

describe('replay gate', () => {
  const source = { packaged: false, electronFromSource: false, dataDir: '/tmp/solus-dev', liveDataDir: '/Users/me/.solus', hasScenarios: true }

  test('a packaged app or released server never offers replay', () => {
    expect(replayBackendAllowed({ ...source, packaged: true })).toBe(false)
    expect(replayBackendAllowed({ ...source, packaged: true, electronFromSource: true })).toBe(false)
  })

  test('without the scenario files of a source checkout there is no replay', () => {
    expect(replayBackendAllowed({ ...source, hasScenarios: false, electronFromSource: true })).toBe(false)
  })

  test('the desktop app run from source offers replay, even on the live data folder', () => {
    expect(replayBackendAllowed({ ...source, electronFromSource: true, dataDir: '/Users/me/.solus' })).toBe(true)
  })

  test('a server run from source offers replay on a sandbox data folder, never on the live one', () => {
    expect(replayBackendAllowed(source)).toBe(true)
    expect(replayBackendAllowed({ ...source, dataDir: '/Users/me/.solus/' })).toBe(false)
  })
})
