import { describe, expect, test } from 'bun:test'
import type { NormalizedEvent } from '@solus/contracts/types'
import { antigravityPlanTool } from '@solus/server/execution/agents/acp/antigravity'
import { AntigravityChildCalls, antigravityChildRecord, type AntigravityChildRecord } from '@solus/server/execution/agents/acp/antigravity-children'
import { request, setup, type FakeAgent, type Json } from './helpers/acp-fake-agent'

/** The `mode` option agy 1.5.18 offers in `session/new`. */
const MODE_OPTION: Json = {
  id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
  options: [{ value: 'default', name: 'Default' }, { value: 'accept-edits', name: 'Accept edits' }, { value: 'auto', name: 'Auto' }, { value: 'plan', name: 'Plan' }],
}

const configOf = (agentReceived: Array<{ method?: string; params?: Json }>) => agentReceived
  .filter((message) => message.method === 'session/set_config_option')
  .map((message) => message.params)

describe('Antigravity plan mode', () => {
  // WHY: in Solus's plan mode agy must be in its own plan mode, where it writes its plan to a
  // file in `brain/` with RequestFeedback (agy 1.5.18). In its default mode it asks to edit, and
  // Solus's plan mode refuses every edit, so no plan would ever arrive.
  test("a plan-mode turn puts agy in plan mode, and the plan it writes is the plan card, not an edit", async () => {
    const plan = '# Implementation Plan: Add `--name`\n\n1. Add argparse.'
    const write = { ArtifactMetadata: { RequestFeedback: true, Summary: 'Plan for --name', UserFacing: true }, Content: plan, Path: '/profile/antigravity-acp/brain/thread-1/add_name_flag_plan.md' }
    const { backend, events, agents } = setup({
      'session/new': () => ({ sessionId: 'thread-1', configOptions: [MODE_OPTION] }),
      'session/set_config_option': () => ({}),
      'session/prompt': (_params, agent) => {
        agent.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'call_plan', title: 'File add_name_flag_plan.md', kind: 'edit', status: 'in_progress', rawInput: write })
        agent.update('thread-1', { sessionUpdate: 'tool_call_update', toolCallId: 'call_plan', kind: 'edit', status: 'completed', rawInput: write })
        return { stopReason: 'end_turn' }
      },
    }, { agent: { planTool: antigravityPlanTool } })

    await backend.startRun(request({ permissionMode: 'plan' })).runPromise
    expect(configOf(agents[0]!.received)).toEqual([{ sessionId: 'thread-1', configId: 'mode', value: 'plan' }])
    expect(events.filter((event) => event.type === 'plan')).toEqual([
      { type: 'plan', planContent: plan, planFilePath: write.Path, questionId: 'call_plan', options: [], planToolUseId: 'call_plan' },
    ])
    expect(events.some((event) => event.type === 'tool_call' && event.toolId === 'call_plan')).toBe(false)

    // The plan accepted, the next turn runs in agy's default mode, which asks and Solus answers.
    await backend.startRun(request({ permissionMode: 'supervised', conversation: { kind: 'resume', threadId: 'thread-1' } })).runPromise
    expect(configOf(agents[0]!.received).at(-1)).toEqual({ sessionId: 'thread-1', configId: 'mode', value: 'default' })
    backend.shutdown()
  })

  test('outside plan mode a file agy writes is an edit card', async () => {
    const write = { ArtifactMetadata: { RequestFeedback: true }, Content: '# Notes', Path: '/profile/brain/thread-1/notes.md' }
    const { backend, events } = setup({
      'session/prompt': (_params, agent) => {
        agent.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'call_write', title: 'File notes.md', kind: 'edit', status: 'completed', rawInput: write })
        return { stopReason: 'end_turn' }
      },
    }, { agent: { planTool: antigravityPlanTool } })
    await backend.startRun(request()).runPromise
    expect(events.some((event) => event.type === 'plan')).toBe(false)
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({ toolId: 'call_write', toolName: 'Edit' })
    backend.shutdown()
  })
})

/** Protobuf bytes in the shape of agy's child metadata: other fields, the parent (5), and the launch (8). */
function childMetadata(parent: string, role: string, prompt: string): Uint8Array {
  const encoder = new TextEncoder()
  const field = (number: number, value: Uint8Array) => [number * 8 + 2, ...varint(value.length), ...value]
  const varint = (value: number) => {
    const bytes: number[] = []
    while (value >= 0x80) { bytes.push((value & 0x7f) | 0x80); value = Math.floor(value / 128) }
    return [...bytes, value]
  }
  const launch = new Uint8Array([...field(1, encoder.encode('self')), ...field(2, encoder.encode(role)), ...field(3, encoder.encode(prompt)), 7 * 8, ...varint(1318)])
  return new Uint8Array([...field(3, encoder.encode('cascade')), ...varint(17 * 8), 1, ...field(4, new Uint8Array(300)), ...field(5, encoder.encode(parent)), ...field(8, launch)])
}

describe('Antigravity subagent steps', () => {
  test("a child's record names its parent session and the role and prompt it was launched with", () => {
    expect(antigravityChildRecord(childMetadata('thread-1', 'File and Command Inspector', 'Read main.py'))).toEqual({
      parentSessionId: 'thread-1', role: 'File and Command Inspector', prompt: 'Read main.py',
    })
  })

  // WHY: agy 1.5.18 sends a subagent's own calls on the parent session as `<child id>:call_…`, and its
  // launch call names no child. Without the match, a child's command shows as the parent's own.
  test("a subagent's calls show inside the card of the launch its record names", async () => {
    const records: Record<string, AntigravityChildRecord> = {
      'child-b': { parentSessionId: 'thread-1', role: 'Tester', prompt: 'Run the tests' },
    }
    const launch = (toolCallId: string, Role: string, Prompt: string) => ({ sessionUpdate: 'tool_call', toolCallId, title: 'Run invoke_subagent', kind: 'other', status: 'completed', rawInput: { Prompt, Role, TypeName: 'self' } })
    const { backend, events } = setup({
      'session/prompt': (_params, agent) => {
        agent.update('thread-1', launch('call_a', 'Reader', 'Read main.py'))
        agent.update('thread-1', launch('call_b', 'Tester', 'Run the tests'))
        agent.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'child-b:call_1', title: 'bun test', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'bun test' } })
        agent.update('thread-1', { sessionUpdate: 'tool_call_update', toolCallId: 'child-b:call_1', status: 'completed', rawOutput: { output: 'ok' } })
        // A child with no readable record goes to the launch that has no child yet.
        agent.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'child-a:call_1', title: 'ls', kind: 'execute', status: 'completed', rawInput: { CommandLine: 'ls' } })
        agent.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'call_own', title: 'pwd', kind: 'execute', status: 'completed', rawInput: { CommandLine: 'pwd' } })
        return { stopReason: 'end_turn' }
      },
    }, { agent: { childCalls: (_request, threadId) => new AntigravityChildCalls(threadId, (childId) => records[childId] ?? null) } })

    await backend.startRun(request()).runPromise
    const parentOf = (toolId: string) => events.filter((event): event is Extract<NormalizedEvent, { type: 'tool_call' | 'tool_call_complete' }> =>
      (event.type === 'tool_call' || event.type === 'tool_call_complete') && event.toolId === toolId).map((event) => event.parentToolUseId)
    expect(parentOf('child-b:call_1')).toEqual(['call_b', 'call_b'])
    expect(parentOf('child-a:call_1')).toEqual(['call_a', 'call_a'])
    expect(parentOf('call_own')).toEqual([undefined, undefined])
    backend.shutdown()
  })
})

describe('Antigravity work after the prompt', () => {
  // WHY: with a daemon schedule, agy 1.5.18 answers the prompt and later replies by itself ("tick")
  // with no turn open. Solus dropped that reply. The wake's turn must take it, and must not send a
  // prompt: agy would answer it too.
  test('a reply with no turn wakes the session once, and the wake turn shows it without a prompt', async () => {
    let agent: FakeAgent | undefined
    const { backend, events, agents } = setup({
      'session/prompt': (_params, fake) => {
        agent = fake
        fake.update('thread-1', { sessionUpdate: 'tool_call', toolCallId: 'call_schedule', title: 'Run schedule', kind: 'other', status: 'in_progress', rawInput: { CronExpression: '@every 30s', IsDaemon: true, Prompt: 'say tick' } })
        fake.update('thread-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'scheduled.' } })
        return { stopReason: 'end_turn' }
      },
    }, { agent: { startsDaemon: (toolCall) => JSON.stringify(toolCall.rawInput ?? null).includes('"IsDaemon":true') } })
    const wakes: string[] = []
    backend.on('background-task-completed', (threadId: string, prompt: string) => wakes.push(`${threadId}: ${prompt}`))
    await backend.startRun(request()).runPromise

    agent!.update('thread-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\ntick' } })
    agent!.update('thread-1', { sessionUpdate: 'usage_update', used: 10, size: 100 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(wakes).toEqual([`thread-1: ${backend.agentWorkPrompt}`])

    const before = events.length
    await backend.startRun(request({ prompt: backend.agentWorkPrompt, conversation: { kind: 'resume', threadId: 'thread-1' } })).runPromise
    const turn = events.slice(before)
    expect(turn.filter((event) => event.type === 'text_chunk').map((event) => event.type === 'text_chunk' && event.text)).toEqual(['\n\ntick'])
    expect(turn.some((event) => event.type === 'task_complete')).toBe(true)
    expect(agents[0]!.methods().filter((method) => method === 'session/prompt')).toHaveLength(1)
    backend.shutdown()
  }, 10_000)
})
