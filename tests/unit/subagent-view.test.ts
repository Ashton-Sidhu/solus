import { describe, expect, test } from 'bun:test'
import {
  briefAsks,
  briefMeta,
  formatOffset,
  reportSections,
  reportText,
  subagentFileCounts,
  subagentFooter,
  subagentHeader,
  subagentProgress,
  subagentTail,
  subagentTimeline,
  writesClause,
} from '@solus/workspace-ui/components/conversation/lib/subagent-view'
import type { Message, TodoItem } from '@solus/contracts/types'

const NOW = 100_000
const FALLBACK = { model: 'Sonnet 5', effort: 'medium' }

function agent(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    role: 'tool',
    content: '',
    toolName: 'Agent',
    timestamp: NOW - 60_000,
    toolCompletedAt: NOW,
    toolStatus: 'completed',
    subMessages: [],
    ...overrides,
  } as Message
}

function step(id: string, toolName: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName,
    toolStatus: 'completed',
    timestamp: NOW - 59_000,
    ...overrides,
  } as Message
}

describe('subagent header', () => {
  test('omits a worktree the session does not have, rather than printing an empty clause', () => {
    const header = subagentHeader(
      agent({ id: 'a', subagentType: 'explore', toolInput: JSON.stringify({ description: 'Find the fields' }) }),
      FALLBACK,
      '',
      NOW,
    )

    expect(header.title).toBe('Find the fields')
    expect(header.identity).toBe('Explore agent, Sonnet 5')
    expect(header.verb).toBe('finished in')
    expect(header.duration).toBe('1m 0s')
    expect(header.worktree).toBe('')
  })

  test('a general-purpose agent names only its model — "agent agent" says nothing', () => {
    expect(subagentHeader(agent({ id: 'a', subagentType: 'general-purpose' }), FALLBACK, '', NOW).identity)
      .toBe('Sonnet 5')
  })

  test('a backgrounded agent still reads as running: its tool result landed at launch', () => {
    // toolStatus tracks the agent, not the tool call. A result here must not make
    // the sentence claim the run finished a minute ago.
    const header = subagentHeader(
      agent({ id: 'a', toolStatus: 'running', report: 'Launched', toolCompletedAt: NOW - 59_000 }),
      FALLBACK,
      'run-host-selection',
      NOW,
    )

    expect(header.state).toBe('running')
    expect(header.verb).toBe('running for')
    // Measured against now, not against the launch acknowledgement.
    expect(header.duration).toBe('1m 0s')
    expect(header.worktree).toBe('run-host-selection')
  })

  test('a failed agent says so instead of reporting a finish time', () => {
    expect(subagentHeader(agent({ id: 'a', toolStatus: 'error' }), FALLBACK, '', NOW).verb)
      .toBe('failed after')
  })

  test('a read-only run says "wrote none" out loud — the common case, worth confirming', () => {
    const header = subagentHeader(
      agent({
        id: 'a',
        subMessages: [
          step('s1', 'Read', { toolInput: JSON.stringify({ file_path: 'a.ts' }) }),
          step('s2', 'Read', { toolInput: JSON.stringify({ file_path: 'b.ts' }) }),
        ],
      }),
      FALLBACK,
      '',
      NOW,
    )

    expect(header.files).toBe('read 2 files, wrote none')
  })

  test('an agent that touched nothing gets no files clause at all', () => {
    expect(subagentHeader(agent({ id: 'a' }), FALLBACK, '', NOW).files).toBe('')
  })
})

describe('file counts', () => {
  test('counts distinct paths, not calls — six reads of one file read one file', () => {
    const subs = [
      step('s1', 'Read', { toolInput: JSON.stringify({ file_path: 'a.ts' }) }),
      step('s2', 'Read', { toolInput: JSON.stringify({ file_path: 'a.ts' }) }),
      step('s3', 'Edit', { toolInput: JSON.stringify({ file_path: 'b.ts' }) }),
      step('s4', 'Write', { toolInput: JSON.stringify({ file_path: 'b.ts' }) }),
      step('s5', 'Grep', { toolInput: JSON.stringify({ pattern: 'x' }) }),
    ]

    expect(subagentFileCounts(subs)).toEqual({ read: 1, wrote: 1 })
  })

  test('a running call is not counted: its input has not landed yet', () => {
    const subs = [step('s1', 'Read', { toolStatus: 'running', toolInput: JSON.stringify({ file_path: 'a.ts' }) })]

    expect(subagentFileCounts(subs)).toEqual({ read: 0, wrote: 0 })
  })
})

describe('report text', () => {
  test('a running agent has no report yet — its latest prose remains transcript progress', () => {
    const message = agent({
      id: 'a',
      toolStatus: 'running',
      report: 'Launched',
      subMessages: [
        { id: 's1', role: 'assistant', content: 'Still editing the files.', timestamp: NOW - 10_000 } as Message,
      ],
    })

    expect(reportText(message)).toBe('')
    expect(
      subagentTimeline(message)
        .filter((entry) => entry.kind === 'text')
        .map((entry) => entry.kind === 'text' && entry.isReport),
    ).toEqual([false])
  })

  test('a backgrounded agent never returns a tool result, so its last words are the answer', () => {
    const message = agent({
      id: 'a',
      subMessages: [
        { id: 's1', role: 'assistant', content: 'Looking into it.', timestamp: NOW - 50_000 } as Message,
        { id: 's2', role: 'assistant', content: 'Five headings, one per ask.', timestamp: NOW - 10_000 } as Message,
      ],
    })

    expect(reportText(message)).toBe('Five headings, one per ask.')
  })

  test('the tool result wins when there is one — that is what the main agent was told', () => {
    expect(reportText(agent({ id: 'a', report: 'The answer.', subMessages: [] }))).toBe('The answer.')
  })
})

describe('report outline', () => {
  test('numbers the sections and keeps the verdict as the lead', () => {
    const outline = reportSections(
      [
        'The data exists, mostly.',
        '',
        '## Worktree name',
        'Read the projection.',
        '',
        'A session carries its checkout on gitContext.',
        '',
        '## Diff stats',
        'None exist.',
      ].join('\n'),
    )

    expect(outline?.lead).toBe('The data exists, mostly.')
    expect(outline?.sections.map((s) => [s.n, s.heading])).toEqual([
      [1, 'Worktree name'],
      [2, 'Diff stats'],
    ])
    // A section states its finding before its evidence: the opening paragraph is
    // lifted into the wash and the support runs on underneath it.
    expect(outline?.sections[0].verdict).toBe('Read the projection.')
    expect(outline?.sections[0].body).toBe('A session carries its checkout on gitContext.')
  })

  test('decodes HTML entities in headings extracted from markdown', () => {
    const outline = reportSections(
      ['## Data model &amp; persistence', 'Stored.', '', '## API &amp; UI', 'Rendered.'].join('\n'),
    )

    expect(outline?.sections.map((section) => section.heading)).toEqual([
      'Data model & persistence',
      'API & UI',
    ])
  })

  test('a section with nothing but its opening paragraph is all verdict, no body', () => {
    const outline = reportSections(['## One', 'Just this.', '', '## Two', 'And this.'].join('\n'))

    expect(outline?.sections.map((s) => [s.verdict, s.body])).toEqual([
      ['Just this.', ''],
      ['And this.', ''],
    ])
  })

  test('a paragraph too long to read as a verdict is left in the prose rather than washed', () => {
    const long = `${'The data exists but the plumbing does not. '.repeat(6)}`.trim()
    const outline = reportSections(['## One', long, '', 'More.', '', '## Two', 'Short.'].join('\n'))

    expect(outline?.sections[0].verdict).toBe('')
    expect(outline?.sections[0].body).toBe(`${long}\n\nMore.`)
  })

  test('a section that opens on a list or a fence keeps it — a wash would break the structure', () => {
    const outline = reportSections(
      ['## One', '- first', '- second', '', '## Two', '```ts', 'const a = 1', '```'].join('\n'),
    )

    expect(outline?.sections.map((s) => s.verdict)).toEqual(['', ''])
    expect(outline?.sections[0].body).toBe('- first\n- second')
  })

  test('a one-heading report gets no rail — numbering it would invent a structure the agent did not write', () => {
    expect(reportSections('## Only finding\nJust the one.')).toBeNull()
    expect(reportSections('Plain prose with no headings at all.')).toBeNull()
  })

  test('splits on the shallowest level present, so sub-points stay inside their section', () => {
    const outline = reportSections(
      ['## One', '### Detail', 'inner', '## Two', 'second'].join('\n'),
    )

    expect(outline?.sections.map((s) => s.heading)).toEqual(['One', 'Two'])
    expect(outline?.sections[0].body).toBe('### Detail\ninner')
  })

  test('a # inside a fenced block is code, not a section — a shell comment must not split the report', () => {
    const outline = reportSections(
      ['## Setup', '```bash', '# install deps', 'bun install', '```', '## Teardown', 'done'].join('\n'),
    )

    expect(outline?.sections.map((s) => s.heading)).toEqual(['Setup', 'Teardown'])
  })

  test('a heading is resolved to text, because both surfaces set it as chrome rather than markdown', () => {
    const outline = reportSections(
      [
        '## 1. Hidden `BrowserWindow`',
        'one',
        '## 2. **Chromium** at [runtime](https://example.com)',
        'two',
      ].join('\n'),
    )

    expect(outline?.sections.map((s) => s.heading)).toEqual([
      'Hidden BrowserWindow',
      'Chromium at runtime',
    ])
  })

  test('an underscore in a heading is an identifier, not emphasis', () => {
    const outline = reportSections(['## solus_data_dir', 'one', '## Teardown', 'two'].join('\n'))

    expect(outline?.sections[0].heading).toBe('solus_data_dir')
  })
})

describe('brief asks', () => {
  test('reads the numbered asks the dispatch spelled out', () => {
    expect(briefAsks('Answer these:\n1. Worktree name\n2) Diff stats\nThanks.')).toEqual([
      'Worktree name',
      'Diff stats',
    ])
  })

  test('an unnumbered brief has no asks to count', () => {
    expect(briefAsks('Just go and look at the auth flow.')).toEqual([])
  })

  test('the card counts asks against sections and never claims a per-ask match', () => {
    expect(briefMeta(['one', 'two'], 2)).toEqual(['2 asks', 'all answered'])
    // More sections than asks still reads as answered — the agent gave extra, not less.
    expect(briefMeta(['one', 'two'], 3)).toEqual(['2 asks', 'all answered'])
    expect(briefMeta(['one', 'two', 'three'], 2)).toEqual(['3 asks', '2 of 3 answered'])
    // No rail means nothing to count against, so the card only says what it asked.
    expect(briefMeta(['one'], 0)).toEqual(['1 ask'])
    expect(briefMeta([], 4)).toEqual([])
  })

  test('a read-only run says so on the brief — the common case, worth confirming', () => {
    expect(writesClause(agent({ id: 'a' }))).toBe('No writes')
    expect(
      writesClause(
        agent({
          id: 'a',
          subMessages: [step('s1', 'Edit', { toolInput: JSON.stringify({ file_path: 'a.ts' }) })],
        }),
      ),
    ).toBe('1 file written')
  })
})

describe('timeline', () => {
  test('consecutive calls share one step, so the margin prints a time per step, not per call', () => {
    const message = agent({
      id: 'a',
      subagentType: 'explore',
      toolInput: JSON.stringify({ prompt: 'Find it.\n1. one\n2. two' }),
      subMessages: [
        step('s1', 'Grep', { timestamp: NOW - 55_000 }),
        step('s2', 'Read', { timestamp: NOW - 54_000 }),
        { id: 's3', role: 'assistant', content: 'Settled.', timestamp: NOW - 20_000 } as Message,
        step('s4', 'Read', { timestamp: NOW - 19_000 }),
      ],
    })

    const entries = subagentTimeline(message)

    expect(entries.map((e) => e.kind)).toEqual(['dispatch', 'tools', 'text', 'tools'])
    expect(entries[0].kind === 'dispatch' && entries[0].asks).toEqual(['one', 'two'])
    // The dispatch names itself so the reader can see what the main agent called.
    expect(entries[0].kind === 'dispatch' && entries[0].call).toBe('Agent · subagent_type: explore')
    // Offsets are relative to dispatch, so the gutter reads as run time.
    expect(entries[1].offsetMs).toBe(5_000)
    // The whole run of calls goes to one grouped activity row, not n step rows.
    expect(entries[1].kind === 'tools' && entries[1].tools.map((t) => t.id)).toEqual(['s1', 's2'])
  })

  test('the block the Report tab shows is marked in the stream, never a second message', () => {
    const message = agent({
      id: 'a',
      report: 'Five headings, one per ask.',
      subMessages: [
        { id: 's1', role: 'assistant', content: 'Looking into it.', timestamp: NOW - 50_000 } as Message,
        {
          id: 's2',
          role: 'assistant',
          content: 'Five headings, one per ask.',
          timestamp: NOW - 10_000,
        } as Message,
      ],
    })

    const texts = subagentTimeline(message).filter((e) => e.kind === 'text')

    expect(texts.map((e) => e.kind === 'text' && e.isReport)).toEqual([false, true])
  })

  test('a last block that is not the answer stays plain prose — the run ended without a report', () => {
    const message = agent({
      id: 'a',
      report: 'Interrupted before it answered.',
      subMessages: [
        { id: 's1', role: 'assistant', content: 'Halfway through ask 03…', timestamp: NOW - 10_000 } as Message,
      ],
    })

    const texts = subagentTimeline(message).filter((e) => e.kind === 'text')

    expect(texts.map((e) => e.kind === 'text' && e.isReport)).toEqual([false])
  })

  test('the tail states the size of the run and does not claim a stop reason we cannot see', () => {
    const message = agent({
      id: 'a',
      subMessages: [
        step('s1', 'Read', { toolInput: JSON.stringify({ file_path: 'a.ts' }) }),
        step('s2', 'Grep', { toolInput: JSON.stringify({ pattern: 'x' }) }),
      ],
    })

    expect(subagentTail(message)).toEqual({ label: 'Turn ended', facts: '2 tool calls · 1 file read' })
    expect(subagentTail(agent({ id: 'a', toolStatus: 'running' })).label).toBe('Still running')
    expect(subagentTail(agent({ id: 'a', toolStatus: 'error' })).label).toBe('Turn failed')
    // Nothing ran, so there is nothing to size — the row prints no facts at all.
    expect(subagentTail(agent({ id: 'a' })).facts).toBe('')
  })
})

describe('progress line', () => {
  const BRIEF = 'Answer these:\n1. Worktree name\n2. Diff stats\n3. Stopping one call'

  function todo(content: string, status: TodoItem['status']): TodoItem {
    return { content, status }
  }

  function planWrite(todos: TodoItem[]): Message {
    return step('plan', 'TodoWrite', { toolInput: JSON.stringify({ todos }) })
  }

  test('a live run with a plan states its position, and the plan names the step', () => {
    const progress = subagentProgress(
      agent({
        id: 'a',
        toolStatus: 'running',
        subTodos: [todo('one', 'completed'), todo('two', 'in_progress'), todo('three', 'pending')],
      }),
      NOW,
    )

    expect(progress.label).toBe('Step 2 of 3')
    expect(progress.current).toBe('two')
    expect(progress.segments.map((segment) => segment.status)).toEqual(['done', 'active', 'pending'])
  })

  test('the step in flight fills by the calls spent on it and never claims to be done', () => {
    const plan = [todo('one', 'in_progress')]
    const fillAfter = (calls: number) =>
      subagentProgress(
        agent({
          id: 'a',
          toolStatus: 'running',
          subTodos: plan,
          subMessages: [planWrite(plan), ...Array.from({ length: calls }, (_, i) => step(`s${i}`, 'Read'))],
        }),
        NOW,
      ).segments[0].fill

    expect(fillAfter(0)).toBe(0)
    expect(fillAfter(3)).toBeGreaterThan(fillAfter(1))
    // Forty calls on one step is still that step in flight, never a finished one.
    expect(fillAfter(40)).toBe(88)
  })

  test('a landed run counts the headings the agent wrote against the asks it was given', () => {
    const progress = subagentProgress(
      agent({
        id: 'a',
        toolInput: JSON.stringify({ prompt: BRIEF }),
        report: '## Worktree name\nRead it.\n\n## Diff stats\nNone exist.',
      }),
      NOW,
    )

    expect(progress.label).toBe('2 of 3 answered')
    // The Report tab carries the same fraction, so the count survives the tab switch.
    expect(progress.fraction).toBe('2 of 3')
    expect(progress.segments.map((segment) => segment.status)).toEqual(['done', 'done', 'pending'])
  })

  test('a live run with no plan of its own invents no position', () => {
    const progress = subagentProgress(
      agent({
        id: 'a',
        toolStatus: 'running',
        toolInput: JSON.stringify({ prompt: BRIEF }),
        report: 'Launched',
      }),
      NOW,
    )

    // The brief says how much work there is, never how much of it is done.
    expect(progress.label).toBe('Working')
    expect(progress.fraction).toBe('')
    // The shape of the work is known before any of it starts, so the segments
    // exist — unfilled, because nothing says which ask it is on.
    expect(progress.segments.map((segment) => segment.status)).toEqual(['pending', 'pending', 'pending'])
  })

  test('a stopped run keeps the step it stopped on visible, and its partial work counted', () => {
    const plan = [todo('one', 'completed'), todo('two', 'in_progress'), todo('three', 'pending')]

    expect(subagentProgress(agent({ id: 'a', toolStatus: 'error', subTodos: plan }), NOW))
      .toMatchObject({
        label: 'Stopped at step 2',
        segments: [{ status: 'done' }, { status: 'stopped' }, { status: 'pending' }],
      })
    // Two answers are still two answers when the unit is the brief's asks.
    expect(
      subagentProgress(
        agent({
          id: 'a',
          toolStatus: 'error',
          toolInput: JSON.stringify({ prompt: BRIEF }),
          report: '## Worktree name\nRead it.\n\n## Diff stats\nNone exist.',
        }),
        NOW,
      ).label,
    ).toBe('Stopped · 2 of 3 answered')
  })

  test('a finished plan reads as the record of what it closed, not a position', () => {
    expect(
      subagentProgress(agent({ id: 'a', subTodos: [todo('one', 'completed'), todo('two', 'completed')] }), NOW).label,
    ).toBe('2 of 2 done')
  })

  test('the line still states what the run cost when nothing gave it a denominator', () => {
    const progress = subagentProgress(
      agent({
        id: 'a',
        toolInput: JSON.stringify({ prompt: 'Just go and look at the auth flow.' }),
        subMessages: [
          step('s1', 'Read', { toolInput: JSON.stringify({ file_path: 'a.ts' }) }),
          step('s2', 'Read', { toolInput: JSON.stringify({ file_path: 'b.ts' }) }),
        ],
      }),
      NOW,
    )

    // No asks and no plan: a segment rail here would be inventing the shape of
    // the work, so the line carries only what the run is known to have cost.
    expect(progress.segments).toEqual([])
    expect(progress.label).toBe('Finished')
    expect(progress.facts).toEqual(['1m 0s', '2 read', '0 written'])
  })

  test('a run that touched no files reports its clock alone', () => {
    expect(subagentProgress(agent({ id: 'a' }), NOW).facts).toEqual(['1m 0s'])
  })

  test('the clock stops at the settle: a landed line is a record, not a counter', () => {
    const landed = agent({ id: 'a', timestamp: NOW - 60_000, toolCompletedAt: NOW - 30_000 })

    expect(subagentProgress(landed, NOW + 600_000).facts).toEqual(['30s'])
  })
})

describe('live footer', () => {
  test('names the call in flight and how big the run has got', () => {
    const footer = subagentFooter(
      agent({
        id: 'a',
        toolStatus: 'running',
        subMessages: [
          step('s1', 'Grep', { toolInput: JSON.stringify({ pattern: 'x' }) }),
          step('s2', 'Read', {
            toolStatus: 'running',
            toolInput: JSON.stringify({ file_path: 'lib/workspace.context.svelte.ts' }),
          }),
        ],
        backgroundTaskProgress: { totalTokens: 24_100 },
      }),
    )

    expect(footer.activity).toBe('Reading')
    // The participle already carries the verb, so the target is just what it names.
    expect(footer.target).toBe('lib/workspace.context.svelte.ts')
    expect(footer.facts).toEqual(['2 tool calls', '24.1K ctx'])
  })

  test("a backgrounded agent's own words for its step beat our participle", () => {
    // Its calls are relayed as a heartbeat rather than a sub-transcript, so the
    // count comes off the heartbeat too.
    expect(
      subagentFooter(
        agent({
          id: 'a',
          toolStatus: 'running',
          backgroundTaskProgress: { description: 'Mapping the RPC chain', toolUses: 9 },
        }),
      ),
    ).toEqual({ activity: 'Mapping the RPC chain', target: '', facts: ['9 tool calls'] })
  })
})

describe('offset', () => {
  test('pads both fields so the gutter is a true column', () => {
    expect(formatOffset(0)).toBe('00:00')
    expect(formatOffset(5_400)).toBe('00:05')
    expect(formatOffset(106_000)).toBe('01:46')
  })
})
