import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { WorkspaceContext } from '../../src/renderer/contexts/workspace/workspace.context.svelte'
import type { IpcContext } from '../../src/shared/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@client-core/server-connections', () => ({
  serverConnections: connections,
}))

const {
  loadRestoredSessionTranscript,
  loadSessionTranscript,
  RESTORED_TRANSCRIPT_LIMIT,
} = await import('../../src/renderer/contexts/workspace/session-transcript')

afterEach(() => connections.reset())

describe('session transcript rehydration', () => {
  test('preserves the full transcript when startup does not request a window', async () => {
    const history = Array.from({ length: 150 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      timestamp: index,
    }))
    const limits: Array<number | undefined> = []
    connections.registerPrimary('transcript-host', {
      loadSession: async (
        _sessionId: string,
        _projectPath: string,
        _ctx: IpcContext,
        _provider: string,
        limit?: number,
      ) => {
        limits.push(limit)
        return limit ? history.slice(-limit) : history
      },
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'codex',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    expect(limits).toEqual([undefined])
    expect(transcript.messages).toHaveLength(150)
    expect(transcript.messages[0]?.content).toBe('message-0')
    expect(transcript.messages.at(-1)?.content).toBe('message-149')
    expect(transcript.truncated).toBe(false)
  })

  test('marks restored transcript windows for on-demand expansion', async () => {
    const history = Array.from({ length: RESTORED_TRANSCRIPT_LIMIT + 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      timestamp: index,
    }))
    connections.registerPrimary('transcript-host', {
      loadSession: async (
        _sessionId: string,
        _projectPath: string,
        _ctx: IpcContext,
        _provider: string,
        limit?: number,
      ) => limit ? history.slice(-limit) : history,
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'codex',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
      limit: RESTORED_TRANSCRIPT_LIMIT,
    })

    expect(transcript.messages).toHaveLength(RESTORED_TRANSCRIPT_LIMIT)
    expect(transcript.truncated).toBe(true)
  })

  test('applies the restore window to every transcript in a provider handoff', async () => {
    const limits: Array<{ sessionId: string; limit?: number }> = []
    const history = Array.from({ length: RESTORED_TRANSCRIPT_LIMIT + 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      timestamp: index,
    }))
    connections.registerPrimary('transcript-host', {
      loadSession: async (
        sessionId: string,
        _projectPath: string,
        _ctx: IpcContext,
        _provider: string,
        limit?: number,
      ) => {
        limits.push({ sessionId, limit })
        return limit ? history.slice(-limit) : history
      },
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext
    const common = {
      loadPath: '/repo',
      displayCwd: '/repo',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    }

    const predecessor = await loadRestoredSessionTranscript(ctx, {
      ...common,
      sessionId: 'predecessor',
      provider: 'claude-code',
    })
    const current = await loadRestoredSessionTranscript(ctx, {
      ...common,
      sessionId: 'current',
      provider: 'codex',
    })

    expect(limits).toEqual([
      { sessionId: 'predecessor', limit: RESTORED_TRANSCRIPT_LIMIT },
      { sessionId: 'current', limit: RESTORED_TRANSCRIPT_LIMIT },
    ])
    expect(predecessor.messages).toHaveLength(RESTORED_TRANSCRIPT_LIMIT)
    expect(current.messages).toHaveLength(RESTORED_TRANSCRIPT_LIMIT)
    expect(predecessor.truncated).toBe(true)
    expect(current.truncated).toBe(true)
  })
})
