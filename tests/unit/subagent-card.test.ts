import { describe, expect, test } from 'bun:test'
import {
  runCardDetail,
  seamSegments,
  stepsRail,
  subagentFigures,
  subagentRail,
  subagentTargetPath,
  subagentVerdict,
} from '@solus/workspace-ui/components/conversation/lib/subagent-card'
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

describe('the seam', () => {
  test('an agent that wrote no plan draws no seam, because there is no denominator to draw', () => {
    // Seven pips over a number we invented would read as progress we can't vouch for.
    expect(seamSegments({ done: 4, total: 0 }, 'running')).toEqual([])
  })

  test('the live segment is the step in flight, not the one after it', () => {
    expect(seamSegments({ done: 2, total: 5 }, 'running')).toEqual([
      'done',
      'done',
      'live',
      'pending',
      'pending',
    ])
  })

  test('a failed run marks the step it died on, so the reader can see where it stopped', () => {
    expect(seamSegments({ done: 3, total: 5 }, 'failed')).toEqual([
      'done',
      'done',
      'done',
      'failed',
      'pending',
    ])
  })

  test('a run that closed every step has no step in flight to mark', () => {
    expect(seamSegments({ done: 3, total: 3 }, 'running')).toEqual(['done', 'done', 'done'])
  })

  test('a count past its own total never overruns the seam', () => {
    // A plan that shrank mid-run would otherwise report more done than exist.
    expect(seamSegments({ done: 9, total: 2 }, 'running')).toEqual(['done', 'done'])
  })
})

describe('the rail', () => {
  test('the denominator is dropped when the agent kept no plan, leaving a bare count', () => {
    expect(stepsRail({ done: 4, total: 0 })).toBe('4')
  })

  test('a plan gives the count a real denominator', () => {
    expect(stepsRail({ done: 3, total: 7 })).toBe('3/7')
  })

  test('a plan-less agent with no tool calls prints no bare zero next to its clock', () => {
    // A zero next to a moving clock reads as a hang.
    expect(stepsRail({ done: 0, total: 0 })).toBe('')
    expect(subagentRail({ steps: { done: 0, total: 0 }, elapsedMs: 12_000 })).toBe('12s')
  })

  test('the rail is counts and then time, never prose', () => {
    expect(subagentRail({ steps: { done: 2, total: 5 }, elapsedMs: 75_000 })).toBe('2/5 · 1m 15s')
  })
})

describe('the live target', () => {
  test('a long path keeps only the segments that place the file', () => {
    expect(
      subagentTargetPath('/Users/sidhu/solus/.git/solus/worktrees/run-4ktpq/src/renderer/panels/HostPicker.svelte'),
    ).toBe('renderer/panels/HostPicker.svelte')
  })

  test('a bare filename is left as it is', () => {
    expect(subagentTargetPath('host-cache.ts')).toBe('host-cache.ts')
  })

  test('a search pattern is left whole — slicing it into directories would invent a structure', () => {
    expect(subagentTargetPath('cache key/ttl in renderer')).toBe('cache key/ttl in renderer')
  })
})

describe('the run card line', () => {
  // WHY: the glyph shows the state (spinner, warning), so the line says only
  // what the agent is doing, never a status word beside it.
  test('the step in flight and what it is on read as one line', () => {
    expect(
      runCardDetail({ state: 'running', activity: 'Reading', target: '/repo/src/renderer/panels/HostPicker.svelte' }),
    ).toBe('Reading renderer/panels/HostPicker.svelte')
  })

  test('an agent’s own step description is kept whole, to truncate at the card’s width', () => {
    expect(runCardDetail({ state: 'running', activity: 'Reading src/shared/types.ts', target: '' }))
      .toBe('Reading src/shared/types.ts')
  })

  test('a failed agent has no line; its reason is left for the body', () => {
    expect(runCardDetail({ state: 'failed', activity: 'Permission denied for Bash', target: '' })).toBe('')
  })
})

describe('the figure table', () => {
  test('writes are named, because the names are what a reader checks', () => {
    const figures = subagentFigures(
      agent({
        id: 'a',
        subMessages: [
          step('1', 'Edit', JSON.stringify({ file_path: '/repo/src/HostPicker.svelte' })),
          step('2', 'Write', JSON.stringify({ file_path: '/repo/src/host-cache.ts' })),
        ],
      }),
    )

    expect(figures).toHaveLength(1)
    expect(figures[0].figure).toBe('2')
    expect(figures[0].label).toBe('files written')
    expect(figures[0].names).toEqual(['HostPicker.svelte', 'host-cache.ts'])
    expect(figures[0].more).toBe(0)
  })

  test('reads are omitted because their count measures effort rather than the result', () => {
    const subMessages = Array.from({ length: 34 }, (_, i) =>
      step(String(i), 'Read', JSON.stringify({ file_path: `/repo/src/file-${i}.ts` })),
    )
    expect(subagentFigures(agent({ id: 'a', subMessages }))).toEqual([])
  })

  test('a run that touched nothing prints no rows, rather than a table of zeroes', () => {
    // An empty row is a fact about the card, not about the agent.
    expect(subagentFigures(agent({ id: 'a', subMessages: [step('1', 'Bash')] }))).toEqual([])
  })

  test('more writes than fit are counted off, so the card never becomes a directory listing', () => {
    const subMessages = Array.from({ length: 5 }, (_, i) =>
      step(String(i), 'Edit', JSON.stringify({ file_path: `/repo/a-${i}.ts` })),
    )
    const [writes] = subagentFigures(agent({ id: 'a', subMessages }))

    expect(writes.names).toHaveLength(3)
    expect(writes.more).toBe(2)
  })
})

describe('the verdict', () => {
  test('the card leads with the report’s own first paragraph, never a summary of it', () => {
    const verdict = subagentVerdict(
      agent({
        id: 'a',
        report: 'The picker re-fetched hosts on every open.\n\nKeying on machine id fixes it.',
      }),
    )
    expect(verdict).toBe('The picker re-fetched hosts on every open.')
  })

  test('a report that opens on a heading still has a first sentence', () => {
    const verdict = subagentVerdict(
      agent({ id: 'a', report: '## Summary\n\nThe cache key included the panel instance.' }),
    )
    expect(verdict).toBe('The cache key included the panel instance.')
  })

  test('a structured report has no lead paragraph, so the card claims no verdict', () => {
    const verdict = subagentVerdict(
      agent({
        id: 'a',
        report: '## Entry point\n\nFound the handler.\n\n## Transport\n\nIt crosses RPC.',
      }),
    )
    expect(verdict).toBe('')
  })

  test('a report that opens on a list keeps its own shape instead of being washed into prose', () => {
    expect(subagentVerdict(agent({ id: 'a', report: '- one finding\n- another' }))).toBe('')
  })

  test('a paragraph too long to take at a glance is left to the pane', () => {
    const long = `${'The cache key included the panel instance. '.repeat(12)}`
    expect(subagentVerdict(agent({ id: 'a', report: long }))).toBe('')
  })

  test('a running agent has no verdict yet, so the card claims none', () => {
    expect(
      subagentVerdict(agent({ id: 'a', toolStatus: 'running', report: 'partial thinking' })),
    ).toBe('')
  })
})
