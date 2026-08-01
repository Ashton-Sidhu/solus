import { describe, expect, test } from 'bun:test'
import { loadSessionTranscript } from '../../src/renderer/contexts/workspace/session-transcript'
import type { WorkspaceContext } from '../../src/renderer/contexts/workspace/workspace.context.svelte'
import type { IpcContext } from '../../src/shared/types'

describe('session transcript rehydration', () => {
  test('preserves the full transcript when startup does not request a window', async () => {
    const history = Array.from({ length: 150 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      timestamp: index,
    }))
    const limits: Array<number | undefined> = []
    const ctx = {
      apiFor: () => ({
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
      }),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'codex',
      ctx: { session: { tabId: 'tab-1' } } as IpcContext,
    })

    expect(limits).toEqual([undefined])
    expect(transcript.messages).toHaveLength(150)
    expect(transcript.messages[0]?.content).toBe('message-0')
    expect(transcript.messages.at(-1)?.content).toBe('message-149')
    expect(transcript.truncated).toBe(false)
  })
})
