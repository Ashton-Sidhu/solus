import { expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { AcpBackend } from '@solus/server/execution/agents/acp/acp-backend'
import type { AcpAgent } from '@solus/server/execution/agents/acp/acp-agent'
import { FakeAgent, FakeChild, INITIALIZE, request, temporaryDirectory, testAgent } from './helpers/acp-fake-agent'

/** A backend whose agent has the sessions in `held`, as one host process sees them. */
function backendIn(historyDirectory: string, held: Set<string>, created = 0) {
  const agents: FakeAgent[] = []
  let sessions = created
  const agent: AcpAgent = {
    ...testAgent,
    launch: () => ({ file: 'agy', args: ['acp'], env: {}, connectionKey: 'alice', authMethod: null, tempRoot: null, place: '/data/state-seats/antigravity/alice' }),
    sessionMeta: (_initialize, systemPrompt) => systemPrompt === undefined ? undefined : { systemPrompt },
  }
  const backend = new AcpBackend({
    agent, historyDirectory, indexMessages: () => {},
    spawnAgent: () => {
      const fake = new FakeAgent({
        initialize: () => INITIALIZE,
        'session/new': () => {
          const sessionId = `agy-${++sessions}`
          held.add(sessionId)
          return { sessionId, configOptions: [] }
        },
        'session/resume': (params) => {
          const sessionId = (params as { sessionId: string }).sessionId
          if (!held.has(sessionId)) throw new Error(`Failed to read session ${sessionId}; retry, or load it with session/load`)
          return { configOptions: [] }
        },
        'session/prompt': (params, self) => {
          const sessionId = (params as { sessionId: string }).sessionId
          self.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer in ${sessionId}` } })
          return { stopReason: 'end_turn' }
        },
      })
      agents.push(fake)
      return new FakeChild(fake) as unknown as ChildProcess
    },
  })
  return { backend, agents }
}

test('a thread whose profile lost its agy session after a restart goes on by handoff', async () => {
  // WHY: where each member is a Linux user, the member's agy profile is in memory and a
  // restart empties it, but the record of which agy session holds the thread is in the
  // server's data, which the backup keeps. The next turn resumed that session, agy refused
  // it ("Failed to read session"), and the turn ended dead (Cloudflare proof runs 12 and 13).
  const history = temporaryDirectory()
  const before = backendIn(history, new Set())
  await before.backend.startRun(request({ prompt: 'The code word is heron.' })).runPromise
  before.backend.shutdown()

  // The same host after a restore: the record is back, the profile is empty.
  const after = backendIn(history, new Set(), 1)
  const handoffs: string[] = []
  after.backend.on('thread-handed-off', (threadId: string) => handoffs.push(threadId))
  await after.backend.startRun(request({ prompt: 'Name the code word.', conversation: { kind: 'resume', threadId: 'agy-1' } })).runPromise

  const agent = after.agents[0]!
  const sent = (method: string) => agent.received.filter((message) => message.method === method).map((message) => message.params as { sessionId?: string; _meta?: { systemPrompt?: string } })
  expect(sent('session/resume').map((params) => params.sessionId)).toEqual(['agy-1'])
  const opened = sent('session/new')
  expect(opened).toHaveLength(1)
  expect(opened[0]!._meta?.systemPrompt).toContain('You are taking over an ongoing Solus conversation')
  expect(sent('session/prompt').map((params) => params.sessionId)).toEqual(['agy-2'])
  expect(handoffs).toEqual(['agy-1'])
  // One Solus thread: both turns are in its history.
  expect((await after.backend.loadSession('agy-1')).filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['The code word is heron.', 'Name the code word.'])
})
