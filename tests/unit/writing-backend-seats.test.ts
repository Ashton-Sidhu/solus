import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { SeatRequiredError, type TurnSeat } from '@solus/server/execution/seats/seat-manager'

const realCliEnv = await import('@solus/server/cli-env')
const realSettings = await import('@solus/server/host/settings')
// A cloud host: both CLIs are installed and the host's writing model is Codex.
mock.module('@solus/server/cli-env', () => ({ ...realCliEnv, findOnPath: (bin: string) => `/fixture/bin/${bin}` }))
mock.module('@solus/server/host/settings', () => ({
  ...realSettings,
  resolveTextGenerationModel: () => ({ provider: 'codex', model: 'gpt-6-luna' }),
}))
const { generateSessionMetadata } = await import('@solus/server/execution/sessions/session-title')
const { generateWorktreeName } = await import('@solus/server/git/worktree-name')
afterAll(() => mock.restore())

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
    expect(dispatcher.requests[0].model).toBe('claude-haiku-4-5-20251001')
    expect(dispatcher.requests[0].seat).toBe(claudeSeat)
  })

  test('keeps the host writing model when the caller can use it', async () => {
    const dispatcher = namingDispatcher()
    await generateSessionMetadata(dispatcher, 'name my cloud sessions', '/repo', undefined, async () => null)
    expect(dispatcher.requests[0].provider).toBe('codex')
    expect(dispatcher.requests[0].model).toBe('gpt-6-luna')
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
