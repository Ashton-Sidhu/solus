import { EventEmitter } from 'node:events'
import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

class FakeCodexClient extends EventEmitter {
  threadReadCalls = 0

  async request(method: string): Promise<any> {
    if (method === 'thread/start') {
      return { thread: { id: 'ephemeral-thread' } }
    }
    if (method === 'turn/start') {
      setTimeout(() => {
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId: 'ephemeral-thread',
            turnId: 'turn-1',
            item: {
              id: 'message-1',
              type: 'agentMessage',
              text: 'Implemented the requested fix.',
              phase: 'final_answer',
            },
          },
        })
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: 'ephemeral-thread',
            turnId: 'turn-1',
            turn: {
              id: 'turn-1',
              status: 'completed',
              durationMs: 10,
            },
          },
        })
      }, 0)
      return { turn: { id: 'turn-1' } }
    }
    if (method === 'thread/read') {
      this.threadReadCalls++
      throw new Error('ephemeral threads do not support includeTurns')
    }
    throw new Error(`Unexpected request: ${method}`)
  }

  respond(): void {}
}

const client = new FakeCodexClient()

mock.module('../../src/main/agents/codex/codex-agent', () => ({
  getCodexAppServerClient: () => client,
  registerHeadlessThread: () => {},
  unregisterHeadlessThread: () => {},
}))

const { runCodexOneShot } = await import('../../src/main/agents/codex/codex-oneshot')

describe('runCodexOneShot', () => {
  test('returns the streamed final answer without rereading an ephemeral thread', async () => {
    // WHY: ephemeral Codex threads cannot be read with includeTurns after
    // completion, but their assembled final answer already arrived live.
    const result = await runCodexOneShot({
      prompt: 'Implement the fix',
      cwd: process.cwd(),
      ephemeral: true,
    })

    expect(result).toEqual({
      text: 'Implemented the requested fix.',
      sessionId: 'ephemeral-thread',
      toolCallCount: 0,
    })
    expect(client.threadReadCalls).toBe(0)
  })
})
