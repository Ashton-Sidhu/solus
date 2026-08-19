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

function todo(content: string, status: 'completed' | 'in_progress' | 'pending') {
  return { content, status }
}

const FALLBACK = { model: 'Sonnet 5', effort: 'medium' }

/** The group derives its rows once and counts those — mirror that here. */
function summarize(messages: Message[], now = NOW, worktree = '') {
  return subagentGroupSummary(
    messages,
    messages.map((message) => subagentRow(message, now, FALLBACK)),
    now,
    worktree,
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
    // No plan, so the rail can only report the calls it made — never a fraction.
    expect(row.steps).toEqual({ done: 2, total: 0 })
    // A settled row's elapsed is what it took, not how long ago it landed.
    expect(row.elapsedMs).toBe(46_000)
  })

  // The agent's own plan is the only thing that knows how many steps there are;
  // without it the rail would have to invent a denominator to print "5/8".
  test('an agent that keeps a plan gives the rail a real denominator', () => {
    const row = subagentRow(
      agent({
        id: 'a',
        toolStatus: 'running',
        subTodos: [
          todo('Read the token map', 'completed'),
          todo('Rewrite call sites', 'completed'),
          todo('Add the guard test', 'in_progress'),
          todo('Update the docs', 'pending'),
        ],
        subMessages: [step('s1', 'Read'), step('s2', 'Edit')],
      }),
      NOW,
      FALLBACK,
    )

    // The plan wins over the tool count — 2 tools ran, but 2 of 4 steps are done.
    expect(row.steps).toEqual({ done: 2, total: 4 })
  })

  test('an SDK heartbeat supplies live activity and a bare tool count without inventing todos', () => {
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
    expect(row.steps).toEqual({ done: 7, total: 0 })
    expect(row.elapsedMs).toBe(75_000)
  })

  // Agents in one fan-out are routinely dispatched with different models, so the
  // dispatch belongs to the row — the header may only carry what they share.
  test('the row carries the dispatch: named type, model and effort', () => {
    const asked = subagentRow(
      agent({
        id: 'a',
        subagentType: 'Explore',
        toolInput: JSON.stringify({ model: 'Haiku 4.5', reasoning_effort: 'low' }),
      }),
      NOW,
      FALLBACK,
    )
    expect(asked.meta).toBe('Explore · Haiku 4.5 · Low')

    // Nothing asked for: the parent session's own dispatch is what ran.
    const inherited = subagentRow(agent({ id: 'b', subagentType: 'general-purpose' }), NOW, FALLBACK)
    expect(inherited.meta).toBe('Sonnet 5 · Medium')
  })

  // A reloaded transcript replays no events, so the todos have to come back off
  // the TodoWrite the agent actually ran.
  test('a reloaded agent recovers its plan from the TodoWrite in its transcript', () => {
    const row = subagentRow(
      agent({
        id: 'a',
        toolStatus: 'completed',
        toolCompletedAt: NOW,
        subMessages: [
          step('s1', 'TodoWrite', JSON.stringify({ todos: [todo('Sweep the portal', 'pending')] })),
          step(
            's2',
            'TodoWrite',
            JSON.stringify({ todos: [todo('Sweep the portal', 'completed')] }),
          ),
        ],
      }),
      NOW,
      FALLBACK,
    )

    // The last write is the plan — an earlier one would report stale progress.
    expect(row.steps).toEqual({ done: 1, total: 1 })
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

  // The header may only carry what the agents genuinely share — never a summed
  // step count, which means nothing across agents doing different work.
  test('the header carries the count, the shared checkout, and the state tally', () => {
    const summary = summarize(
      [
        agent({ id: 'a', toolStatus: 'running' }),
        agent({ id: 'b', toolStatus: 'running' }),
        agent({ id: 'c', toolStatus: 'completed', toolCompletedAt: NOW }),
      ],
      NOW,
      'font-secondary',
    )

    expect(summary.meta).toEqual(['3 agents', 'worktree font-secondary', '1 done, 2 running'])
  })

  test('a session that is not isolated says nothing about a worktree', () => {
    const summary = summarize([agent({ id: 'a', toolStatus: 'running' })])
    expect(summary.meta).toEqual(['1 agent'])
  })

  // The tally exists to spell out mixed states; when they all match, the chip has
  // already said it and repeating it in the meta line only adds noise.
  test('the tally is dropped when every agent is in the same state', () => {
    const summary = summarize([
      agent({ id: 'a', toolStatus: 'completed', toolCompletedAt: NOW }),
      agent({ id: 'b', toolStatus: 'completed', toolCompletedAt: NOW }),
    ])

    expect(summary.chip).toBe('2 done')
    expect(summary.meta).toEqual(['2 agents'])
  })

  test('the title names the shared agent type, and never repeats a generic one', () => {
    const typed = summarize([
      agent({ id: 'a', subagentType: 'Explore' }),
      agent({ id: 'b', subagentType: 'Explore' }),
    ])
    expect(typed.title).toBe('2 Explore agents in parallel')

    const generic = summarize([
      agent({ id: 'a', subagentType: 'general-purpose' }),
      agent({ id: 'b', subagentType: 'general-purpose' }),
    ])
    expect(generic.title).toBe('2 agents in parallel')

    const mixed = summarize([
      agent({ id: 'a', subagentType: 'Explore' }),
      agent({ id: 'b', subagentType: 'Plan' }),
    ])
    expect(mixed.title).toBe('2 agents in parallel')
  })
})
