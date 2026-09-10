import { describe, expect, test } from 'bun:test'
import { MockAgentBackend } from '../e2e/mock/mock-backend'
import { MockHistory } from '../e2e/mock/mock-history'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { NormalizedEvent } from '@solus/contracts/types'

const request: AgentRunRequest = {
  provider: 'claude-code', prompt: '__MOCK_HOLD__', cwd: '/fixture', tools: [],
  permissionMode: 'ask', persistence: 'session', service: 'solus.subagents',
}

for (const provider of ['claude-code', 'codex'] as const) {
  describe(provider, () => {
    test('abort before initialization removes pending run and emits no success', async () => {
      const backend = new MockAgentBackend(provider, new MockHistory(provider, ''))
      const events: NormalizedEvent[] = []
      backend.on('normalized', (_sessionId, event) => events.push(event))
      const handle = backend.startRun({ ...request, provider })
      handle.abortController.abort()
      await handle.runPromise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(backend.getPendingHandles()).toEqual([])
      expect(backend.runTrackingSnapshot().activeRunSessionIds).toEqual([])
      expect(events).toEqual([])
    })

    test('permission response settles only its waiting session and can resume history', async () => {
      const history = new MockHistory(provider, '')
      const backend = new MockAgentBackend(provider, history)
      let questionId = ''
      backend.on('normalized', (_sessionId: string, event: NormalizedEvent) => {
        if (event.type === 'permission_request') questionId = event.questionId
      })
      const waiting = backend.startRun({ ...request, provider, prompt: '__MOCK_PERMISSION__' })
      const other = backend.startRun({ ...request, provider })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(questionId).not.toBe('')
      expect(backend.permissions.respondToPermission(questionId, 'allow')).toBe(true)
      await waiting.runPromise
      expect(backend.isSessionRunning(waiting.agentSessionId!)).toBe(false)
      expect(backend.isSessionRunning(other.agentSessionId!)).toBe(true)
      expect(history.load(waiting.agentSessionId!).at(-1)?.content).toContain('Permission approved')
      const resumed = backend.startRun({ ...request, provider, conversation: { kind: 'resume', threadId: waiting.agentSessionId! }, prompt: 'follow-up\n\n[Working On Task "__MOCK_PERMISSION__"]' })
      await resumed.runPromise
      expect(resumed.agentSessionId).toBe(waiting.agentSessionId)
      expect(history.load(resumed.agentSessionId!)).toHaveLength(4)
      expect(history.load(resumed.agentSessionId!)[2].content).toBe('follow-up')
      backend.cancelSession(other.agentSessionId!)
      await other.runPromise
    })

    test('cancel during a text callback emits no late completion', async () => {
      const backend = new MockAgentBackend(provider, new MockHistory(provider, ''))
      const events: NormalizedEvent[] = []
      backend.on('normalized', (sessionId: string, event: NormalizedEvent) => {
        events.push(event)
        if (event.type === 'text_chunk') backend.cancelSession(sessionId)
      })
      const handle = backend.startRun({ ...request, provider, prompt: 'normal response' })
      await handle.runPromise
      expect(events.some((event) => event.type === 'text_chunk')).toBe(true)
      expect(events.some((event) => event.type === 'task_complete')).toBe(false)
      expect(backend.isSessionRunning(handle.agentSessionId!)).toBe(false)
    })

    test('cancel one active session without canceling another', async () => {
      const backend = new MockAgentBackend(provider, new MockHistory(provider, ''))
      const first = backend.startRun({ ...request, provider })
      const second = backend.startRun({ ...request, provider })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(first.agentSessionId).not.toBe(second.agentSessionId)
      expect(backend.cancelSession(first.agentSessionId!)).toBe(true)
      await first.runPromise
      expect(backend.isSessionRunning(first.agentSessionId!)).toBe(false)
      expect(backend.isSessionRunning(second.agentSessionId!)).toBe(true)
      backend.cancelSession(second.agentSessionId!)
      await second.runPromise
    })
  })
}
