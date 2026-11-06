import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { Model } from '@solus/server/execution/agents/codex/generated/v2/Model'
import { SeatRequiredError, type TurnSeat } from '@solus/server/execution/seats/seat-manager'

const realCliEnv = await import('@solus/server/cli-env')
const realSettings = await import('@solus/server/host/settings')
const realSeatLogin = await import('@solus/server/execution/seats/seat-login')
const { codexWritingModel, rememberCodexModels } = await import('@solus/server/execution/agents/codex/listed-models')
// A cloud host: both CLIs are installed and the host's writing model is Codex.
mock.module('@solus/server/cli-env', () => ({ ...realCliEnv, findOnPath: (bin: string) => `/fixture/bin/${bin}` }))
mock.module('@solus/server/host/settings', () => ({
  ...realSettings,
  resolveTextGenerationModel: () => ({ provider: 'codex', model: 'gpt-6-luna' }),
}))
// The host logins this host holds. Each test starts with both signed in.
let hostLogins = new Set<string>(['codex', 'claude-code'])
mock.module('@solus/server/execution/seats/seat-login', () => ({
  ...realSeatLogin,
  providerLoginConnected: async (provider: string) => hostLogins.has(provider),
}))
const { generateSessionMetadata } = await import('@solus/server/execution/sessions/session-title')
const { generateWorktreeName } = await import('@solus/server/git/worktree-name')
const { writingBackendFor } = await import('@solus/server/execution/agents/writing-backend')
afterAll(() => mock.restore())
beforeEach(() => {
  hostLogins = new Set(['codex', 'claude-code'])
  rememberCodexModels([])
})

function namingDispatcher() {
  const requests: AgentRunRequest[] = []
  return {
    requests,
    runAgent(request: AgentRunRequest): AgentRun {
      requests.push(request)
      const done = (async () => {
        await request.tools[0].execute({ title: 'Cloud Session Names', description: 'Name cloud sessions.' } as never, {} as never)
        return { sessionId: null, output: '', toolCallCount: 1, permissionDenials: [], exitCode: 0, signal: null }
      })()
      return { sessionId: Promise.resolve(null), done, cancel: () => {}, handle: {} as never }
    },
  }
}

function listed(model: string, fields: Partial<Model> = {}): Model {
  return { id: model, model, upgrade: null, isDefault: false, ...fields } as Model
}

describe('the model a writing run asks Codex for', () => {
  test.each([
    ['keeps a listed model', 'gpt-6-luna', [listed('gpt-6-luna'), listed('gpt-6-astra', { isDefault: true })], 'gpt-6-luna'],
    ['keeps the request when the list is unread', 'gpt-6-luna', [], 'gpt-6-luna'],
    ['takes the account default', 'gpt-6-luna', [listed('gpt-5'), listed('gpt-6-astra', { isDefault: true })], 'gpt-6-astra'],
    ['takes a current model before a legacy one', 'gpt-6-luna', [listed('gpt-4', { upgrade: 'gpt-5' }), listed('gpt-5')], 'gpt-5'],
    ['takes any model when all are legacy', 'gpt-6-luna', [listed('gpt-4', { upgrade: 'gpt-5' })], 'gpt-4'],
  ] as [string, string, Model[], string][])('%s', (_, requested, models, expected) => {
    expect(codexWritingModel(requested, models)).toBe(expected)
  })
})

describe('background writing on a host with seats', () => {
  test('names the session with the backend the caller is signed in to, on their own seat', async () => {
    // WHY: a cloud member signed in only to Claude got no names: the run chose
    // Codex because it is installed, and ran on the host login, not the member's.
    const claudeSeat: TurnSeat = {
      seat: { kind: 'user', userId: { kind: 'account', accountId: 'member-1' } },
      provider: 'claude-code',
      home: '/seats/member-1/claude',
    }
    const dispatcher = namingDispatcher()
    const metadata = await generateSessionMetadata(dispatcher, 'name my cloud sessions', '/repo', undefined, async (provider) => {
      if (provider === 'codex') throw new SeatRequiredError('codex', 'none')
      return claudeSeat
    })

    expect(metadata?.title).toBe('Cloud Session Names')
    expect(dispatcher.requests).toHaveLength(1)
    expect(dispatcher.requests[0].provider).toBe('claude-code')
    expect(dispatcher.requests[0].model).toBe('claude-haiku-5-5')
    expect(dispatcher.requests[0].seat).toBe(claudeSeat)
  })

  test('keeps the host writing model when the caller can use it', async () => {
    const dispatcher = namingDispatcher()
    await generateSessionMetadata(dispatcher, 'name my cloud sessions', '/repo', undefined, async () => null)
    expect(dispatcher.requests[0].provider).toBe('codex')
    expect(dispatcher.requests[0].model).toBe('gpt-6-luna')
  })

  test('a signed-out host login gives way to the backend that is signed in', async () => {
    // WHY: Codex is the default writing backend. A person who uses only Claude
    // has its CLI installed but signed out, and got no names at all.
    hostLogins = new Set(['claude-code'])
    const dispatcher = namingDispatcher()
    await generateSessionMetadata(dispatcher, 'name my sessions', '/repo', undefined, async () => null)
    expect(dispatcher.requests).toHaveLength(1)
    expect(dispatcher.requests[0].provider).toBe('claude-code')
    expect(dispatcher.requests[0].model).toBe('claude-haiku-5-5')
  })

  test('tries the chosen backend when no login shows, because the CLI can hold another credential', async () => {
    // WHY: an OPENAI_API_KEY runs Codex with no auth.json. Refusing here would name nothing.
    hostLogins = new Set()
    const dispatcher = namingDispatcher()
    await generateSessionMetadata(dispatcher, 'name my sessions', '/repo', undefined, async () => null)
    expect(dispatcher.requests[0].provider).toBe('codex')
  })

  test('a pasted token counts as signed in, with no login file', async () => {
    hostLogins = new Set()
    const seat: TurnSeat = { seat: { kind: 'host-login' }, provider: 'claude-code', home: '/host', envToken: 'token' }
    const backend = await writingBackendFor({ provider: 'claude-code', model: 'claude-haiku-5-5' }, async () => seat, 'local')
    expect(backend).toEqual({ provider: 'claude-code', model: 'claude-haiku-5-5', seat, organizationId: 'local' })
  })

  test('asks the host Codex for a model its account lists', async () => {
    // WHY: Codex refuses a model the account does not list, and every name, commit
    // message, and branch then fails. A ChatGPT login can leave out gpt-6-luna.
    rememberCodexModels([listed('gpt-6-astra', { isDefault: true }), listed('gpt-5.6-luna')])
    const dispatcher = namingDispatcher()
    await generateSessionMetadata(dispatcher, 'name my sessions', '/repo', undefined, async () => null)
    expect(dispatcher.requests[0].provider).toBe('codex')
    expect(dispatcher.requests[0].model).toBe('gpt-6-astra')
  })

  test("leaves a member's model alone, because the list is the host login's", async () => {
    rememberCodexModels([listed('gpt-6-astra', { isDefault: true })])
    const seat: TurnSeat = { seat: { kind: 'user', userId: { kind: 'account', accountId: 'member-1' } }, provider: 'codex', home: '/seats/member-1/codex' }
    const backend = await writingBackendFor({ provider: 'codex', model: 'gpt-6-luna' }, async () => seat, 'local')
    expect(backend?.model).toBe('gpt-6-luna')
  })

  test('names nothing when the caller has no seat for any backend', async () => {
    const dispatcher = namingDispatcher()
    const metadata = await generateSessionMetadata(dispatcher, 'name my cloud sessions', '/repo', undefined, async (provider) => {
      throw new SeatRequiredError(provider, 'none')
    })
    expect(metadata).toBeNull()
    expect(dispatcher.requests).toHaveLength(0)
  })

  test('names a worktree with the same backend and seat a session name uses', async () => {
    const claudeSeat: TurnSeat = {
      seat: { kind: 'user', userId: { kind: 'account', accountId: 'member-1' } },
      provider: 'claude-code',
      home: '/seats/member-1/claude',
    }
    const requests: AgentRunRequest[] = []
    const dispatcher = {
      runAgent(request: AgentRunRequest): AgentRun {
        requests.push(request)
        const done = (async () => {
          await request.tools[0].execute({ name: 'Cloud Session Names' } as never, {} as never)
          return { sessionId: null, output: '', toolCallCount: 1, permissionDenials: [], exitCode: 0, signal: null }
        })()
        return { sessionId: Promise.resolve(null), done, cancel: () => {}, handle: {} as never }
      },
    }
    const name = await generateWorktreeName(dispatcher, 'name my cloud sessions', '/repo', undefined, async (provider) => {
      if (provider === 'codex') throw new SeatRequiredError('codex', 'none')
      return claudeSeat
    })
    expect(name).toBe('Cloud Session Names')
    expect(requests[0].provider).toBe('claude-code')
    expect(requests[0].seat).toBe(claudeSeat)
  })
})
