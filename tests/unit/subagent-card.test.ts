import { describe, expect, test } from 'bun:test'
import {
  seamSegments,
  stepsFigure,
  subagentFigures,
  subagentReportPreview,
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

describe('the step figure', () => {
  test('the denominator is dropped when the agent kept no plan, leaving a bare count', () => {
    expect(stepsFigure({ done: 4, total: 0 })).toEqual({ done: '4', total: '' })
  })

  test('position and total are separate figures, so the rail can set them at two weights', () => {
    expect(stepsFigure({ done: 3, total: 7 })).toEqual({ done: '3', total: '/7' })
  })
})

describe('the live target', () => {
  test('the filename separates from its directory, so the trim stays legible', () => {
    expect(
      subagentTargetPath('/Users/sidhu/solus/.git/solus/worktrees/run-4ktpq/src/renderer/panels/HostPicker.svelte'),
    ).toEqual({ dir: 'renderer/panels/', file: 'HostPicker.svelte' })
  })

  test('a bare filename has no directory to set back', () => {
    expect(subagentTargetPath('host-cache.ts')).toEqual({ dir: '', file: 'host-cache.ts' })
  })

  test('a search pattern is left whole — slicing it into directories would invent a structure', () => {
    expect(subagentTargetPath('cache key/ttl in renderer')).toEqual({
      dir: '',
      file: 'cache key/ttl in renderer',
    })
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

  test('a structured report leaves its section findings to the preview', () => {
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

describe('the report preview', () => {
  test('it indexes the report by section rather than lifting a sentence out of each one', () => {
    const preview = subagentReportPreview(
      agent({
        id: 'a',
        report:
          'Findings below.\n\n## Entry point\n\nThe prompt starts in SessionPicker.\n\n## Transport\n\nThe request crosses the typed RPC boundary.',
      }),
    )

    expect(preview).toEqual({ headings: ['Entry point', 'Transport'], more: 0 })
  })

  test('a section that opens on a list is indexed exactly like one that opens on prose', () => {
    const preview = subagentReportPreview(
      agent({
        id: 'a',
        report: '## Bottom line\n\n- it cannot\n- not today\n\n## Entry point\n\nIt starts here.',
      }),
    )

    // The ragged card came from these two rows differing. They must not.
    expect(preview.headings).toEqual(['Bottom line', 'Entry point'])
  })

  test('a heading arrives as text, so its markdown and its own numbering do not print', () => {
    const preview = subagentReportPreview(
      agent({
        id: 'a',
        report: '## 1. Hidden `BrowserWindow`\n\nFound three.\n\n## 2. **Chromium** at runtime\n\nNone.',
      }),
    )

    expect(preview.headings).toEqual(['Hidden BrowserWindow', 'Chromium at runtime'])
  })

  test('it caps the index at six sections and says how many it left in the report', () => {
    const preview = subagentReportPreview(
      agent({
        id: 'a',
        report: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight']
          .map((heading) => `## ${heading}\n\nBody.`)
          .join('\n\n'),
      }),
    )

    expect(preview.headings).toHaveLength(6)
    expect(preview.more).toBe(2)
  })
})
