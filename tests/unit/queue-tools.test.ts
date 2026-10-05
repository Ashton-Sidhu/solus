import { expect, test } from 'bun:test'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { changeQueueAgentTool, readQueueAgentTool, setAgentQueueController } from '@solus/server/execution/agents/tools/queue-tools'

const context: AgentToolContext = {
  provider: 'codex', cwd: '/project', sessionId: () => 'native-caller', solusSessionId: () => 'caller',
  abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit() {},
}

test('queue tools use the calling session and refuse to resume held work', async () => {
  const reads: string[] = []
  const changes: string[] = []
  setAgentQueueController({
    read: (id) => { reads.push(id); return { held: true, entries: [] } },
    change: async (id) => { changes.push(id); return { held: false, entries: [] } },
  })
  expect((await readQueueAgentTool.execute({}, context)).ok).toBe(true)
  expect(reads).toEqual(['native-caller'])
  expect((await changeQueueAgentTool.execute({ mutation: { kind: 'resume' } }, context)).ok).toBe(false)
  expect(changes).toEqual([])
  expect((await changeQueueAgentTool.execute({ mutation: { kind: 'remove', queueId: 'q', revision: 0 } }, context)).ok).toBe(true)
  expect(changes).toEqual(['native-caller'])
})

test('a provider without a session cannot inspect or mutate another queue', async () => {
  const missing = { ...context, sessionId: () => undefined }
  expect((await readQueueAgentTool.execute({}, missing)).ok).toBe(false)
  expect((await changeQueueAgentTool.execute({ mutation: { kind: 'remove', queueId: 'q', revision: 0 } }, missing)).ok).toBe(false)
})
