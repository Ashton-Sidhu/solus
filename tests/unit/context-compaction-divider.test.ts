import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { IpcContext, Message, Session, Tab } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import { parseJsonlLine } from '@solus/server/execution/agents/claude/claude-session-helpers'
import { codexItemToMessage } from '@solus/server/execution/agents/codex/codex-utils'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { compactionDividerText } from '@solus/workspace-ui/components/conversation/lib/compaction-divider'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { materializeSessionTranscript } = await import('@solus/workspace-ui/contexts/workspace/session-transcript')

// Svelte may have installed `$state` as a throwing getter when another file ran
// first, so save and restore the property itself, never its value.
const previousState = Object.getOwnPropertyDescriptor(globalThis, '$state')
afterEach(() => {
  connections.reset()
  if (previousState) Object.defineProperty(globalThis, '$state', previousState)
  else delete (globalThis as unknown as { $state?: unknown }).$state
})

/** The rows a client draws after a reload: the host's projection, then the client's. */
function reloaded(history: SessionLoadMessage[]): Message[] {
  connections.registerPrimary('transcript-host', {})
  const ctx = { apiForSession: () => connections.apiFor('transcript-host') } as unknown as WorkspaceContext
  return materializeSessionTranscript(ctx, {
    sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider: 'claude-code',
    ctx: { session: { sessionId: 'tab' } } as IpcContext,
  }, projectSessionHistory(history)).messages
}

// WHY: a compaction drops most of what the agent knew. Without a divider the
// reader cannot see where the agent's memory of the thread starts again.
describe('context compaction divider after a reload', () => {
  test('a Claude compact_boundary record draws the divider with its trigger and tokens', () => {
    // The on-disk shape: camel-case `compactMetadata`, unlike the live stream.
    const boundary = parseJsonlLine(JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      uuid: 'boundary-1',
      timestamp: '2026-10-01T10:00:00.000Z',
      compactMetadata: { trigger: 'manual', preTokens: 975_939, postTokens: 12_790, durationMs: 95_711 },
    }))
    expect(boundary).not.toBeNull()

    const messages = reloaded([
      { role: 'user', content: 'Keep going', timestamp: 1 },
      boundary!,
      { role: 'assistant', content: 'Picking up from the summary.', timestamp: Date.parse('2026-10-01T10:00:01.000Z') },
    ])
    const divider = messages.find((message) => message.compaction)
    expect(divider).toMatchObject({ role: 'system', compaction: { trigger: 'manual', preTokens: 975_939, postTokens: 12_790 } })
    expect(compactionDividerText(divider!.compaction!)).toEqual({ label: 'Context compacted on request', detail: '976K → 12.8K tokens' })
  })

  test('a Codex contextCompaction item draws the divider without details it does not report', () => {
    const item = codexItemToMessage({ id: 'compaction-1', type: 'contextCompaction' }, 5_000)
    expect(item).not.toBeNull()

    const messages = reloaded([{ role: 'user', content: 'Keep going', timestamp: 4_000 }, item!])
    const divider = messages.find((message) => message.compaction)
    expect(divider).toMatchObject({ role: 'system', compaction: {} })
    expect(compactionDividerText(divider!.compaction!)).toEqual({ label: 'Context compacted', detail: null })
  })
})

async function createReducer() {
  Object.defineProperty(globalThis, '$state', { value: <T>(value: T) => value, configurable: true, writable: true })
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const session = { status: 'running', messages: [{ id: 'prompt', role: 'user', content: 'Keep going', timestamp: 1 }] } as unknown as Session
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  const reducer = new SessionEventReducer({
    sessions: { byId: { 'session-1': session } },
    registry: {
      tabs: { 'tab-1': tab },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      tabIdsBySession: new Map([['session-1', ['tab-1']]]),
    },
    settings: { rateLimitBehavior: 'ask' },
    log: () => {},
  } as any)
  return { session, reducer }
}

describe('context compaction divider while the turn streams', () => {
  test('Claude settles one compaction twice; one divider keeps the record', async () => {
    const { session, reducer } = await createReducer()
    reducer.apply('session-1', { type: 'context_compaction', state: 'start', trigger: 'auto' })
    // The status that ends the span knows no tokens and always says auto.
    reducer.apply('session-1', { type: 'context_compaction', state: 'stop', trigger: 'auto' })
    reducer.apply('session-1', { type: 'context_compaction', state: 'stop', trigger: 'manual', preTokens: 180_000, postTokens: 12_000 })

    const dividers = session.messages.filter((message) => message.compaction)
    expect(dividers).toHaveLength(1)
    expect(dividers[0].compaction).toEqual({ trigger: 'manual', preTokens: 180_000, postTokens: 12_000 })
  })

  test('the status stop after the record does not overwrite it', async () => {
    const { session, reducer } = await createReducer()
    reducer.apply('session-1', { type: 'context_compaction', state: 'stop', trigger: 'manual', preTokens: 180_000 })
    reducer.apply('session-1', { type: 'context_compaction', state: 'stop', trigger: 'auto' })

    expect(session.messages.filter((message) => message.compaction).map((message) => message.compaction))
      .toEqual([{ trigger: 'manual', preTokens: 180_000 }])
  })

  test('a failed compaction draws no divider', async () => {
    const { session, reducer } = await createReducer()
    reducer.apply('session-1', { type: 'context_compaction', state: 'start', trigger: 'auto' })
    reducer.apply('session-1', { type: 'context_compaction', state: 'stop', trigger: 'auto', failed: true })

    expect(session.messages.some((message) => message.compaction)).toBe(false)
  })
})
