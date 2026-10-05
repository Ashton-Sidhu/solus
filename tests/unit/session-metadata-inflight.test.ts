import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'

const realCliEnv = await import('@solus/server/cli-env')
const realSettings = await import('@solus/server/host/settings')
mock.module('@solus/server/cli-env', () => ({ ...realCliEnv, findOnPath: (bin: string) => `/fixture/bin/${bin}` }))
mock.module('@solus/server/host/settings', () => ({
  ...realSettings,
  resolveTextGenerationModel: () => ({ provider: 'claude-code', model: 'claude-haiku-4-5-20251001' }),
}))
const { generateSessionMetadata } = await import('@solus/server/execution/sessions/session-title')
afterAll(() => mock.restore())

/** A dispatcher whose runs finish only when the test releases them, so two
 *  requests overlap for certain. Each run answers with its own title. */
function heldDispatcher() {
  const requests: AgentRunRequest[] = []
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  return {
    requests,
    release,
    runAgent(request: AgentRunRequest): AgentRun {
      requests.push(request)
      const runNumber = requests.length
      const done = (async () => {
        await released
        await request.tools[0].execute({ title: `Name ${runNumber}`, description: 'Describe it.' } as never, {} as never)
        return { sessionId: null, output: '', toolCallCount: 1, permissionDenials: [], exitCode: 0, signal: null }
      })()
      return { sessionId: Promise.resolve(null), done, cancel: () => {}, handle: {} as never }
    },
  }
}

describe('session metadata generation per session', () => {
  test('a concurrent request for the same session joins the run in flight', async () => {
    // WHY: two clients, or the first-turn name and a regenerate, asked at once.
    // Each started its own run and the last to finish overwrote the other name.
    const dispatcher = heldDispatcher()
    const first = generateSessionMetadata(dispatcher, 'Fix the login redirect', '/repo', { sessionId: 'session-1' })
    const second = generateSessionMetadata(dispatcher, 'Fix the login redirect', '/repo', { sessionId: 'session-1' })
    dispatcher.release()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(dispatcher.requests).toHaveLength(1)
    expect(firstResult).toEqual({ title: 'Name 1', description: 'Describe it.' })
    expect(secondResult).toEqual(firstResult)
  })

  test('a request after the run finished starts a new run', async () => {
    const dispatcher = heldDispatcher()
    dispatcher.release()
    await generateSessionMetadata(dispatcher, 'Fix the login redirect', '/repo', { sessionId: 'session-2' })
    const again = await generateSessionMetadata(dispatcher, 'Fix the login redirect', '/repo', { sessionId: 'session-2' })

    expect(dispatcher.requests).toHaveLength(2)
    expect(again?.title).toBe('Name 2')
  })

  test('different sessions do not share a run', async () => {
    const dispatcher = heldDispatcher()
    const first = generateSessionMetadata(dispatcher, 'Fix the login redirect', '/repo', { sessionId: 'session-3' })
    const second = generateSessionMetadata(dispatcher, 'Add dark mode', '/repo', { sessionId: 'session-4' })
    dispatcher.release()
    await Promise.all([first, second])

    expect(dispatcher.requests).toHaveLength(2)
  })
})
