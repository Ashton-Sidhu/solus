import { describe, expect, mock, test } from 'bun:test'

const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
const { withActor } = await import('./helpers/actors')

type Handler = (args: unknown[], ctx: { clientId: string; principal: unknown }) => Promise<unknown>

function answerHandler() {
  const respondToPermission = mock((..._args: unknown[]) => true)
  const handlers = new Map<string, Handler>()
  const server = { register: (name: string, handler: Handler) => handlers.set(name, (args, ctx) => handler(args, withActor(ctx as never))) } as never
  const sessionRuntime = { dispatch: { admission: null }, inputRequests: { respondToPermission } }
  registerSessionHandlers(server, { sessionRuntime, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => 'claude-code' } as never)
  const respond = (args: unknown[]) => handlers.get('respondPermission')!(args, { clientId: 'ws:owner', principal: { kind: 'owner' } })
  return { respond, respondToPermission }
}

const ctx = { session: { sessionId: 's1' } }

describe('respondPermission over JSON', () => {
  // WHY: JSON turns an omitted trailing argument into null. Allow sends no plan
  // and no feedback, so the host must read null as "none", not as bad feedback.
  test('Allow with null plan and feedback is accepted as no plan and no feedback', async () => {
    const { respond, respondToPermission } = answerHandler()
    await expect(respond([ctx, 's1', 'q1', 'allow', null, null])).resolves.toBe(true)
    const [, , , plan, , feedback] = respondToPermission.mock.calls[0]
    expect(plan).toBeUndefined()
    expect(feedback).toBeUndefined()
  })

  test('feedback text still reaches the request, trimmed', async () => {
    const { respond, respondToPermission } = answerHandler()
    await respond([ctx, 's1', 'q1', 'deny', null, '  try the other file  '])
    expect(respondToPermission.mock.calls[0][5]).toBe('try the other file')
  })

  test('feedback that is not text, or is blank, is still refused', async () => {
    const { respond } = answerHandler()
    await expect(respond([ctx, 's1', 'q1', 'deny', null, 42])).rejects.toThrow('Feedback must be text')
    await expect(respond([ctx, 's1', 'q1', 'deny', null, '   '])).rejects.toThrow('Feedback must be text')
  })
})
