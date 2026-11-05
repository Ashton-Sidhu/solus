import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab } from '@solus/contracts/types'

// t3code #25559: after Stop, Codex drops every later event of the interrupted
// turn, so a plain tool card never hears its end. The client settles it on
// Stop, as it already did for sub-agent cards (mobile: native-mobile-agents.test.ts).
const previousState = (globalThis as unknown as { $state?: unknown }).$state
afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('Stop settles running tool cards', () => {
  test('a plain running tool card is not left running when the session is interrupted', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
    const tool: Message = { id: 'm1', role: 'tool', content: '', toolName: 'Bash', toolId: 'cmd-1', toolStatus: 'running', timestamp: 0 }
    const done: Message = { id: 'm2', role: 'tool', content: 'ok', toolName: 'Read', toolId: 'read-1', toolStatus: 'completed', timestamp: 0 }
    const session = { status: 'running', messages: [tool, done] } as Session
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    const reducer = new SessionEventReducer({
      sessions: { byId: { 'session-1': session } },
      registry: { tabs: { 'tab-1': tab }, sessionFor: () => session, tabIdsBySession: new Map([['session-1', ['tab-1']]]) },
      settings: { rateLimitBehavior: 'ask' }, closePlanModal: () => {}, log: () => {},
    } as any)
    reducer.apply('session-1', { type: 'status_change', status: 'interrupted' })
    expect(tool.toolStatus).toBe('error')
    expect(tool.report).toBeUndefined()
    expect(done.toolStatus).toBe('completed')
  })
})
