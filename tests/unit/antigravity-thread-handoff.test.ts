import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { AcpBackend } from '@solus/server/execution/agents/acp/acp-backend'
import type { AcpAgent } from '@solus/server/execution/agents/acp/acp-agent'
import type { TurnSeat } from '@solus/server/execution/seats/seat-manager'
import { FakeAgent, FakeChild, INITIALIZE, request, temporaryDirectory, testAgent } from './helpers/acp-fake-agent'

/**
 * agy keeps a session in one profile. A member's turn in a session another member's seat started
 * (h7), or a turn on another host after the session cloud copy (h5), runs where that agent session
 * does not exist. The thread goes on there in a new agent session that reads the history from the
 * handoff text, and it stays one Solus thread.
 */
function backendIn(historyDirectory: string, hasThread: (place: string, agentSessionId: string) => boolean) {
  const agents: FakeAgent[] = []
  let sessions = 0
  // The profile is the seat's home; the agent's `_meta` shows the instructions it was given.
  const agent: AcpAgent = {
    ...testAgent,
    launch: (run) => ({ file: 'agy', args: ['acp'], env: {}, connectionKey: run.seat?.home ?? 'owner', authMethod: null, tempRoot: null, place: run.seat?.home ?? 'owner' }),
    sessionMeta: (_initialize, systemPrompt) => systemPrompt === undefined ? undefined : { systemPrompt },
    hasThread,
  }
  const backend = new AcpBackend({
    agent, historyDirectory, indexMessages: () => {},
    spawnAgent: () => {
      const fake = new FakeAgent({
        initialize: () => INITIALIZE,
        'session/new': () => ({ sessionId: `agy-${++sessions}`, configOptions: [] }),
        'session/resume': () => ({ configOptions: [] }),
        'session/set_model': () => ({}),
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

const seat = (home: string) => ({ home, launch: { env: {} } }) as TurnSeat
const received = (agent: FakeAgent, method: string) => agent.received.filter((message) => message.method === method).map((message) => message.params as { sessionId?: string; _meta?: { systemPrompt?: string } })

describe('An Antigravity thread in another place', () => {
  test("a member's turn goes on in their own profile by handoff, and stays the same Solus thread", async () => {
    const own = new Set(['owner:agy-1'])
    const { backend, agents } = backendIn(temporaryDirectory(), (place, agentSessionId) => own.has(`${place}:${agentSessionId}`))
    const handoffs: Array<[string, string | null]> = []
    backend.on('thread-handed-off', (threadId: string, model: string | null) => handoffs.push([threadId, model]))
    await backend.startRun(request({ prompt: 'Start' })).runPromise

    // The second member's profile has no `agy-1`.
    const member = backend.startRun(request({ prompt: 'Go on', model: 'gemini-3.8-flash', seat: seat('member'), conversation: { kind: 'resume', threadId: 'agy-1' } }))
    await member.runPromise
    const memberAgent = agents[1]!
    expect(received(memberAgent, 'session/resume')).toEqual([])
    const opened = received(memberAgent, 'session/new')[0]!
    expect(opened._meta?.systemPrompt).toContain('You are taking over an ongoing Solus conversation')
    const transcript = /read the prior conversation transcript at: (\S+)/.exec(opened._meta!.systemPrompt!)![1]!
    expect(readFileSync(transcript, 'utf8')).toContain('answer in agy-1')
    expect(received(memberAgent, 'session/prompt')[0]!.sessionId).toBe('agy-2')
    // The transcript gets the handoff divider, as for a switch of agent or model.
    expect(handoffs).toEqual([['agy-1', 'gemini-3.8-flash']])

    // The member's next turn resumes their own agent session; the thread's history is one.
    await backend.startRun(request({ prompt: 'More', seat: seat('member'), conversation: { kind: 'resume', threadId: 'agy-1' } })).runPromise
    expect(received(memberAgent, 'session/prompt').map((params) => params.sessionId)).toEqual(['agy-2', 'agy-2'])
    expect((await backend.loadSession('agy-1')).filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['Start', 'Go on', 'More'])
    // The member's own agent session continues with no new handoff.
    expect(handoffs).toHaveLength(1)
    // The owner's profile still resumes the first agent session (one connection per thread: a new one).
    await backend.startRun(request({ prompt: 'Back', conversation: { kind: 'resume', threadId: 'agy-1' } })).runPromise
    expect(received(agents.at(-1)!, 'session/resume').map((params) => params.sessionId)).toEqual(['agy-1'])
    expect(received(agents.at(-1)!, 'session/prompt').map((params) => params.sessionId)).toEqual(['agy-1'])
    backend.shutdown()
  })

  test("a host that imports the thread's cloud copy goes on with its history", async () => {
    const first = backendIn(temporaryDirectory(), () => true)
    await first.backend.startRun(request({ prompt: 'Start' })).runPromise
    const files = await first.backend.threadFiles('agy-1')
    expect(files.map((file) => file.relativePath)).toEqual(['agy-1.jsonl'])
    first.backend.shutdown()

    const otherHost = temporaryDirectory()
    const second = backendIn(otherHost, () => false)
    const imported = await second.backend.importThread({ sessionId: 's1', threadId: 'agy-1', cwd: '/tmp', files: files.map(({ relativePath, path }) => ({ relativePath, path })) })
    expect(imported.files.map((file) => file.status)).toEqual(['written'])
    expect((await second.backend.loadSession('agy-1')).map((row) => row.content)).toEqual(['Start', 'answer in agy-1'])

    await second.backend.startRun(request({ prompt: 'Go on', conversation: { kind: 'resume', threadId: 'agy-1' } })).runPromise
    expect(received(second.agents[0]!, 'session/new')[0]!._meta?.systemPrompt).toContain('read the prior conversation transcript')
    // The turn it adds only appends, so the next cloud copy carries it as new bytes.
    expect(readFileSync(join(otherHost, 'agy-1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4)
    second.backend.shutdown()
  })
})

