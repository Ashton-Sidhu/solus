import { describe, expect, test } from 'bun:test'
import {
  subagentGroupSummary,
  subagentRow,
} from '@solus/workspace-ui/components/conversation/lib/subagent-group'
import type { Message } from '@solus/contracts/types'

const NOW = 100_000

function agent(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    role: 'tool',
    content: '',
    toolName: 'Agent',
    timestamp: NOW - 60_000,
    subMessages: [],
    ...overrides,
  } as Message
}

function step(id: string, toolName: string, toolInput?: string): Message {
  return { id, role: 'tool', content: '', toolName, toolInput, timestamp: NOW } as Message
}

const FALLBACK = { model: 'Sonnet 5', effort: 'medium' }

/** The group derives its rows once and counts those — mirror that here. */
function summarize(messages: Message[], now = NOW) {
  return subagentGroupSummary(
    messages,
    messages.map((message) => subagentRow(message, now, FALLBACK)),
    now,
  )
}

describe('subagent row', () => {
  test('a running agent reads as a participle on what it is doing, never as its result', () => {
    const row = subagentRow(
      agent({
        id: 'a',
        toolStatus: 'running',
        toolInput: JSON.stringify({ description: 'MenuRow' }),
        // A backgrounded agent answers its tool call at launch, so a result here
        // must not make the row claim the agent finished.
        report: 'Launched',
        subMessages: [step('s1', 'Read', JSON.stringify({ file_path: 'src/MenuRow.svelte' }))],
      }),
      NOW,
      FALLBACK,
    )

    expect(row.state).toBe('running')
    expect(row.name).toBe('MenuRow')
    expect(row.activity).not.toContain('Launched')
    expect(row.target).toContain('MenuRow.svelte')
  })

  test('a settled agent states its result as a fact, and stops printing a target', () => {
    const row = subagentRow(
      agent({
        id: 'a',
        toolStatus: 'completed',
        toolInput: JSON.stringify({ description: 'MenuRow' }),
        report: '8 call sites rewritten, guard test added\nmore detail',
        toolCompletedAt: NOW - 14_000,
        subMessages: [step('s1', 'Read'), step('s2', 'Edit')],
      }),
      NOW,
      FALLBACK,
    )

    expect(row.state).toBe('done')
    expect(row.activity).toBe('8 call sites rewritten, guard test added')
    expect(row.target).toBe('')
    // A settled row's elapsed is what it took, not how long ago it landed.
    expect(row.elapsedMs).toBe(46_000)
  })

  test('an SDK heartbeat supplies the live activity and the elapsed time', () => {
    const row = subagentRow(
      agent({
        id: 'a',
        toolStatus: 'running',
        backgroundTaskProgress: {
          description: 'Reading src/shared/types.ts',
          toolUses: 7,
          durationMs: 75_000,
          lastToolName: 'Read',
        },
        subMessages: [step('s1', 'Read')],
      }),
      NOW,
      FALLBACK,
    )

    expect(row.activity).toBe('Reading src/shared/types.ts')
    expect(row.target).toBe('')
    expect(row.elapsedMs).toBe(75_000)
  })

  // Agents in one fan-out are routinely dispatched with different models, so the
  // dispatch belongs to the row — the header may only carry what they share.
  test('the row carries the dispatch: model and effort', () => {
    const asked = subagentRow(
      agent({
        id: 'a',
        subagentType: 'Explore',
        toolInput: JSON.stringify({ model: 'Haiku 4.5', reasoning_effort: 'low' }),
      }),
      NOW,
      FALLBACK,
    )
    expect(asked).toMatchObject({ modelLabel: 'Haiku 4.5', effortLabel: 'Low' })

    // Nothing asked for: the parent session's own dispatch is what ran.
    const inherited = subagentRow(agent({ id: 'b', subagentType: 'general-purpose' }), NOW, FALLBACK)
    expect(inherited).toMatchObject({ modelLabel: 'Sonnet 5', effortLabel: 'Medium' })
  })

  test('an agent that never returned a result falls back to the last thing it said', () => {
    const row = subagentRow(
      agent({
        id: 'a',
        toolStatus: 'completed',
        subMessages: [
          { id: 's1', role: 'assistant', content: 'Rewrote the portal call sites', timestamp: NOW },
        ] as Message[],
      }),
      NOW,
      FALLBACK,
    )

    expect(row.activity).toBe('Rewrote the portal call sites')
  })
})

describe('subagent group summary', () => {
  test('the chip counts, and one failure never turns the whole group destructive', () => {
    const summary = summarize([
      agent({ id: 'a', toolStatus: 'completed', toolCompletedAt: NOW }),
      agent({ id: 'b', toolStatus: 'completed', toolCompletedAt: NOW }),
      agent({ id: 'c', toolStatus: 'error', toolCompletedAt: NOW }),
    ])

    expect(summary.running).toBe(0)
    expect(summary.done).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.chip).toBe('2 done · 1 failed')
  })

  test('in-flight agents are the only thing the chip reports while any are running', () => {
    const summary = summarize([
      agent({ id: 'a', toolStatus: 'running' }),
      agent({ id: 'b', toolStatus: 'running' }),
      agent({ id: 'c', toolStatus: 'completed', toolCompletedAt: NOW }),
    ])

    expect(summary.chip).toBe('2 running')
  })

  test('a live group times against the clock; a settled one against its last landing', () => {
    const live = summarize([agent({ id: 'a', toolStatus: 'running' })])
    expect(live.elapsedMs).toBe(60_000)

    const settled = summarize([
      agent({ id: 'a', toolStatus: 'completed', toolCompletedAt: NOW - 30_000 }),
    ])
    expect(settled.elapsedMs).toBe(30_000)
  })

  test('a group where every agent landed reports the count once', () => {
    const summary = summarize([
      agent({ id: 'a', toolStatus: 'completed', toolCompletedAt: NOW }),
      agent({ id: 'b', toolStatus: 'completed', toolCompletedAt: NOW }),
    ])

    expect(summary.chip).toBe('2 done')
  })

  // WHY: the header names the count the way T3 Code does; the status line
  // carries the states, so the label never changes as agents land.
  test('the group label is the agent count', () => {
    expect(summarize([agent({ id: 'a' }), agent({ id: 'b' })]).title).toBe('2 subagents')
    expect(summarize([agent({ id: 'a' })]).title).toBe('1 subagent')
  })
})

describe('which backend and model a sub-agent card names', () => {
  // WHY: the card line shows the provider's mark and the model, because a
  // reader cannot tell a Codex agent from a Claude one by its task alone.
  const PARENT = { model: 'claude-opus-5-5', effort: 'medium' }

  test('an agent with no model of its own runs on the parent’s model, under Claude', () => {
    expect(subagentRow(agent({ id: 'a' }), NOW, PARENT)).toMatchObject({
      provider: 'claude-code',
      modelLabel: 'Opus 5.5',
    })
  })

  test('a Codex agent is named Codex, with its backend’s default model', () => {
    const row = subagentRow(agent({ id: 'b', subagentType: 'codex' }), NOW, PARENT)
    expect(row.provider).toBe('codex')
    expect(row.modelLabel).not.toBe('')
  })

  test('a model id that only Codex serves marks the agent as Codex', () => {
    const row = subagentRow(
      agent({ id: 'c', toolInput: JSON.stringify({ description: 'x', prompt: 'y', model: 'gpt-6-astra' }) }),
      NOW,
      PARENT,
    )
    expect(row).toMatchObject({ provider: 'codex', modelLabel: 'Gpt 6 Astra' })
  })
})
