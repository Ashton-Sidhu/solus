import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import type { IpcContext } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

const {
  loadRestoredSessionTranscript,
  loadSessionTranscript,
  RESTORED_TRANSCRIPT_LIMIT,
} = await import('@solus/workspace-ui/contexts/workspace/session-transcript')

afterEach(() => connections.reset())

describe('session transcript rehydration', () => {
  test('rebuilds a rendered artifact with the work it was saved as', async () => {
    // WHY: the work id lived in the dropped tool result, so a reloaded frame
    // finds its work the way a create_work card does — by the title the host
    // saved it under, which is the same rule the host applied.
    const html = '<!doctype html><html><head><title>Latency</title></head><body></body></html>'
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{
        role: 'tool' as const,
        content: '',
        toolName: 'mcp__solus__render_artifact',
        toolId: 'artifact-1',
        toolInput: JSON.stringify({ html }),
        timestamp: 1,
      }],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
      worksStore: {
        works: {
          'w-art': { id: 'w-art', title: 'Latency', type: 'artifact', sessionIds: ['session-1'] },
        },
      },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'claude-code',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    expect(transcript.messages[1]).toMatchObject({
      artifact: { kind: 'html', html },
      workRef: { workId: 'w-art', title: 'Latency', workType: 'artifact' },
    })
  })

  test('rebuilds provider-history images as user-message attachments', async () => {
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{
        role: 'user' as const,
        content: 'Please fix this',
        imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' }],
        timestamp: 1,
      }],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'claude-code',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    expect(transcript.messages[0]).toMatchObject({
      role: 'user',
      content: 'Please fix this',
      attachments: [{
        name: '',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,cG5n',
        type: 'image',
      }],
    })
  })

  test('keeps both model labels on a restored handoff divider', async () => {
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{
        role: 'system' as const,
        content: 'Switched to Codex',
        agentChangedTo: 'Codex',
        agentChangedFromModel: 'Sonnet 5',
        agentChangedToModel: 'Gpt 5.4',
        agentChangedFromProvider: 'claude-code' as const,
        agentChangedToProvider: 'codex' as const,
        timestamp: 2,
      }],
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

    // WHY: reloading a session must not reduce a model-to-model boundary back
    // to the older provider-only label.
    expect(transcript.messages[0]).toMatchObject({
      agentChangedFromModel: 'Sonnet 5',
      agentChangedToModel: 'Gpt 5.4',
      agentChangedFromProvider: 'claude-code',
      agentChangedToProvider: 'codex',
    })
  })

  test('keeps projected nested tool status without restoring its output', async () => {
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [
        {
          role: 'tool' as const,
          content: '',
          toolName: 'Agent',
          toolId: 'agent-1',
          toolInput: '{}',
          isSubagent: true,
          timestamp: 1,
        },
        {
          role: 'tool' as const,
          content: '',
          toolName: 'Bash',
          toolId: 'bash-1',
          toolInput: '{"command":"false"}',
          parentToolUseId: 'agent-1',
          status: 'error' as const,
          errorHead: 'command failed',
          contentBytes: 4096,
          timestamp: 2,
        },
      ],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'claude-code',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    const child = transcript.messages[0]?.subMessages?.[0]
    expect(child).toMatchObject({
      content: '',
      toolStatus: 'error',
      errorHead: 'command failed',
      contentBytes: 4096,
    })
  })

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
