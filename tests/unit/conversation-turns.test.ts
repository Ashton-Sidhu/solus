import { describe, expect, test } from 'bun:test'
import type { Message } from '../../src/shared/types'
import {
  buildTurns,
  groupMessages,
  hasVisibleTurnBody,
  itemKey,
  needsLiveRow,
} from '../../src/renderer/components/conversation/lib/turns'

let clock = 1_000

function msg(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  clock += 1_000
  return {
    id: `m${clock}`,
    content: '',
    timestamp: clock,
    ...partial,
  }
}

function tool(name: string, input: string, completed = true): Message {
  const call = msg({ role: 'tool', toolName: name, toolInput: input })
  return completed
    ? { ...call, toolStatus: 'completed', toolCompletedAt: call.timestamp + 500 }
    : { ...call, toolStatus: 'running' }
}

function turnsFor(messages: Message[], running = false) {
  return buildTurns(groupMessages(messages), { running })
}

describe('turn collapse', () => {
  test('folds the narration and the tool calls away, leaving the answer on screen', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'kill the unlayered rule' }),
      msg({ role: 'assistant', content: "I'll look at the stylesheet." }),
      tool('Read', '{"file_path":"index.css"}'),
      tool('Edit', '{"file_path":"index.css"}'),
      msg({ role: 'assistant', content: 'Removed the unlayered rule.' }),
    ])

    // The reader is left with the prompt, one row, and the outcome — everything
    // that says *how* the outcome was reached is behind the chevron.
    expect(turn.lead?.kind).toBe('user')
    expect(turn.body.map((item) => item.kind)).toEqual(['assistant', 'tool-group'])
    expect(turn.tail).toHaveLength(1)
    expect(turn.tail[0].kind === 'assistant' && turn.tail[0].message.content).toBe(
      'Removed the unlayered rule.',
    )
    expect(turn.tools).toHaveLength(2)
  })

  test('leaves prose on screen while the turn is still live', () => {
    const messages = [
      msg({ role: 'user', content: 'rewrite the call sites' }),
      msg({ role: 'assistant', content: 'Starting on the codemod.' }),
      tool('Edit', '{"file_path":"MenuRow.svelte"}', false),
    ]

    // A live turn folds nothing — `body` is what it renders, in order, and the
    // view hides it rather than unmounting it when the turn ends. Keeping the
    // live turn's items in `body` is what makes ending it cost one reflow
    // instead of a rebuild of every subtree that moved blocks.
    const [live] = turnsFor(messages, true)
    expect(live.body.map((item) => item.kind)).toEqual(['assistant', 'tool-group'])
    expect(live.tail).toHaveLength(0)

    const [settled] = turnsFor(messages)
    expect(settled.body.map((item) => item.kind)).toEqual(['assistant', 'tool-group'])
    expect(settled.tail).toHaveLength(0)
  })

  test('ending a turn moves only the answer between blocks', () => {
    const messages = [
      msg({ role: 'user', content: 'rewrite the call sites' }),
      msg({ role: 'assistant', content: 'Starting on the codemod.' }),
      tool('Edit', '{"file_path":"MenuRow.svelte"}'),
      msg({ role: 'assistant', content: 'All rewritten.' }),
    ]

    // Keys are what decide whether Svelte keeps a subtree or rebuilds it, so the
    // invariant is about keys: everything the fold hides was already in `body`
    // while the turn ran, and only the answer changes blocks when it ends.
    const live = turnsFor(messages, true)[0]
    const settled = turnsFor(messages)[0]
    const stayed = new Set(settled.body.map(itemKey))
    const moved = live.body.filter((item) => !stayed.has(itemKey(item)))
    expect(moved.map((item) => item.kind)).toEqual(['assistant'])
    expect(settled.tail.map(itemKey)).toEqual(moved.map(itemKey))
  })

  test('the live row only appears when nothing else is reporting the run', () => {
    const prompt = msg({ role: 'user', content: 'rewrite the call sites' })

    // Nothing on screen yet — the row is the only thing that can say the session
    // is alive, so "Thinking" earns its place.
    expect(needsLiveRow(turnsFor([prompt], true)[0])).toBe(true)

    // A tool group at the tail carries the spinner on its own row, so a second
    // row here would be the stacked pair §16 forbids — and it stays suppressed
    // between calls, when the group has settled but the run has not.
    const settledTool = tool('Read', '{"file_path":"index.css"}')
    const runningTool = tool('Edit', '{"file_path":"index.css"}', false)
    expect(needsLiveRow(turnsFor([prompt, runningTool], true)[0])).toBe(false)
    expect(needsLiveRow(turnsFor([prompt, settledTool], true)[0])).toBe(false)

    // Text arriving on screen *is* the evidence that work is happening, so a
    // row saying so underneath it tells the reader nothing they can't see.
    const streaming = buildTurns(
      [
        { kind: 'user', message: prompt },
        { kind: 'live-assistant', id: 'live-stream', content: 'Rewriting the…' },
      ],
      { running: true },
    )[0]
    expect(needsLiveRow(streaming)).toBe(false)

    // Once that message settles the run goes quiet again, and the row returns.
    expect(
      needsLiveRow(turnsFor([prompt, settledTool, msg({ role: 'assistant', content: 'Done.' })], true)[0]),
    ).toBe(true)
  })

  test('a turn that only answered has no row to collapse into', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'what does tw.ts do?' }),
      msg({ role: 'assistant', content: 'It registers the merge config.' }),
    ])

    expect(turn.tools).toHaveLength(0)
    expect(turn.body).toHaveLength(0)
    expect(turn.tail).toHaveLength(1)
  })

  test('an empty provider placeholder does not create a disclosure target', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'inspect it' }),
      msg({ role: 'system', content: 'Error: API Error: 529 Overloaded' }),
    ])
    turn.body.push({
      kind: 'assistant',
      message: msg({ role: 'assistant', content: '' }),
    })

    expect(hasVisibleTurnBody(turn)).toBe(false)
  })

  test('plans fold with the rest of a finished turn', () => {
    const messages = [
      msg({ role: 'user', content: 'draft the plan' }),
      tool('Read', '{"file_path":"a.ts"}'),
      msg({ role: 'plan', planId: 'plan-1' }),
      msg({ role: 'assistant', content: 'Plan is up.' }),
    ]

    // A plan still waiting on the user keeps the turn live, and a live turn
    // folds nothing — so a pending decision is never behind a chevron.
    const [live] = turnsFor(messages, true)
    expect(live.body.map((item) => item.kind)).toEqual(['tool-group', 'plan', 'assistant'])
    expect(live.tail).toHaveLength(0)

    // Once it is settled the card is history; the project sidebar keeps it.
    const [settled] = turnsFor(messages)
    expect(settled.body.map((item) => item.kind)).toEqual(['tool-group', 'plan'])
    expect(settled.tail.map((item) => item.kind)).toEqual(['assistant'])
  })

  test('keeps rendered artifacts and created resources visible after the turn ends', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'set everything up' }),
      msg({
        role: 'assistant',
        artifact: {
          kind: 'html',
          html: '<html><body><svg aria-label="Review chart"></svg></body></html>',
        },
      }),
      msg({
        role: 'assistant',
        automationRef: {
          automationId: 'automation-1',
          name: 'Daily review',
          trigger: { type: 'manual' },
          enabled: true,
        },
      }),
      tool('Read', '{"file_path":"a.ts"}'),
      msg({
        role: 'assistant',
        relayRef: {
          peerSessionId: 'session-1',
          provider: 'codex',
          title: 'Review worker',
          cwd: '/repo',
          origin: 'created',
          exchanges: [],
        },
      }),
      tool('Read', '{"file_path":"b.ts"}'),
      msg({
        role: 'assistant',
        workRef: {
          workId: 'work-1',
          title: 'Review notes',
          workType: 'doc',
        },
      }),
      msg({ role: 'assistant', content: 'Everything is ready.' }),
    ])

    // WHY: these rendered or actionable items are outcomes of the request. The
    // implementation steps may collapse, but the visualization and things the
    // user can open must not disappear behind the turn disclosure.
    expect(turn.visibleWhenCollapsed.map((item) => item.kind)).toEqual([
      'artifact',
      'automation',
      'relay-group',
      'document',
    ])
    expect(turn.tail.map((item) => item.kind)).toEqual(['assistant'])
  })

  test('a turn\'s relay cards stack at the first dispatch despite interleaved tool rows', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'brief all three' }),
      tool('mcp__solus__prompt_session', '{"session_id":"a"}'),
      msg({
        role: 'assistant',
        relayRef: { peerSessionId: 'a', provider: 'codex', title: 'A', cwd: '/r', origin: 'prompted', exchanges: [] },
      }),
      tool('mcp__solus__prompt_session', '{"session_id":"b"}'),
      msg({
        role: 'assistant',
        relayRef: { peerSessionId: 'b', provider: 'claude-code', title: 'B', cwd: '/r', origin: 'prompted', exchanges: [] },
      }),
      msg({ role: 'assistant', content: 'Briefed both.' }),
    ])

    // WHY: several peers dispatched by one decision are one roster, not two
    // cards separated by their own plumbing rows — the stack anchors where the
    // first dispatch happened and later dispatches join it in place.
    const relayGroups = turn.body.filter((item) => item.kind === 'relay-group')
    expect(relayGroups).toHaveLength(1)
    expect(
      relayGroups[0].kind === 'relay-group'
        ? relayGroups[0].messages.map((m) => m.relayRef?.peerSessionId)
        : [],
    ).toEqual(['a', 'b'])
  })

  test('a turn that never answered is work all the way down', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'go' }),
      tool('Read', '{"file_path":"a.ts"}'),
      msg({ role: 'system', content: '[Request interrupted by user]' }),
    ])

    expect(turn.body.map((item) => item.kind)).toEqual(['tool-group'])
    expect(turn.tail).toHaveLength(0)
  })

  test('steering into a running turn does not collapse it', () => {
    const messages = [
      msg({ role: 'user', content: 'rewrite the call sites' }),
      tool('Edit', '{"file_path":"MenuRow.svelte"}'),
      msg({ role: 'assistant', content: 'Half of them are done.' }),
      msg({ role: 'user', content: 'skip the test files', delivery: 'steer' }),
      tool('Edit', '{"file_path":"Panel.svelte"}', false),
    ]

    // A steer opens a turn without ending the one it interrupted — the run is
    // still going, so neither may fold out from under the reader.
    const running = turnsFor(messages, true)
    expect(running.map((turn) => turn.live)).toEqual([true, true])
    expect(running[0].tail).toHaveLength(0)

    // When that one run finally ends, both of its turns collapse together.
    const settled = turnsFor(messages)
    expect(settled.map((turn) => turn.live)).toEqual([false, false])
    expect(settled[0].tail.map((item) => item.kind)).toEqual(['assistant'])
  })

  test('a fresh prompt ends the turn before it even while the session runs on', () => {
    const messages = [
      msg({ role: 'user', content: 'first' }),
      tool('Read', '{"file_path":"a.ts"}'),
      msg({ role: 'assistant', content: 'done' }),
      msg({ role: 'user', content: 'second' }),
      tool('Read', '{"file_path":"b.ts"}', false),
    ]

    // Without the steer marker the earlier turn belongs to a finished run, so it
    // collapses as normal — only the run in flight stays open.
    const turns = turnsFor(messages, true)
    expect(turns.map((turn) => turn.live)).toEqual([false, true])
  })

  test('each user message opens its own turn', () => {
    const turns = turnsFor([
      msg({ role: 'user', content: 'first' }),
      tool('Read', '{"file_path":"a.ts"}'),
      msg({ role: 'assistant', content: 'done' }),
      msg({ role: 'user', content: 'second' }),
      tool('Read', '{"file_path":"b.ts"}'),
      msg({ role: 'assistant', content: 'done again' }),
    ])

    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.tools.length)).toEqual([1, 1])
  })
})

describe('a run that ended early', () => {
  test('a user stop exposes the terminal state used by the retry divider', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'rewrite the call sites' }),
      tool('Edit', '{"file_path":"MenuRow.svelte"}'),
      msg({ role: 'assistant', content: 'Got through half of them.' }),
      msg({ role: 'system', content: '[Request interrupted by user]' }),
    ])

    expect(turn.end).toMatchObject({ kind: 'stopped', cause: 'by you' })
    // WHY: the interrupt notice is consumed into the turn end so the renderer
    // can show one divider with Retry instead of a second, inert system row.
    expect(turn.tail.map((item) => item.kind)).toEqual(['assistant'])
  })

  test('a failure keeps its complete error for the always-visible diagnosis', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'run the codemod' }),
      tool('Bash', '{"command":"bun codemod"}'),
      msg({
        role: 'system',
        content: 'Error: codemod exited 1\n\nEPIPE writing panels/MenuRow.svelte\n  at write.ts:42',
      }),
    ])

    expect(turn.end?.kind).toBe('failed')
    expect(turn.end?.cause).toBe('codemod exited 1')
    expect(turn.end?.detail).toBe(
      'codemod exited 1\n\nEPIPE writing panels/MenuRow.svelte\n  at write.ts:42',
    )
  })

  test('a one-line provider error is not lost when its row label is shortened', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'inspect the conversation' }),
      tool('Bash', '{"command":"grep conversation"}'),
      msg({
        role: 'system',
        content:
          'Error: API Error: 500 Internal server error. This is a server-side issue, usually temporary.',
      }),
    ])

    expect(turn.end?.cause).toBe(
      'API Error: 500 Internal server error. This is a server-side i…',
    )
    expect(turn.end?.detail).toBe(
      'API Error: 500 Internal server error. This is a server-side issue, usually temporary.',
    )
  })

  test('an error landing after the answer does not drag the answer into the fold', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'run the codemod' }),
      tool('Bash', '{"command":"bun codemod"}'),
      msg({ role: 'assistant', content: 'Half of them are rewritten.' }),
      msg({ role: 'system', content: 'Error: codemod exited 1' }),
    ])

    expect(turn.end?.kind).toBe('failed')
    expect(turn.body.map((item) => item.kind)).toEqual(['tool-group'])
    expect(turn.tail.map((item) => item.kind)).toEqual(['assistant'])
  })

  test('a retry does not expose an obsolete terminal notice as hidden work', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'run the codemod' }),
      msg({ role: 'system', content: '[Request interrupted by user]' }),
      msg({ role: 'system', content: 'Error: request.tools is not iterable' }),
    ])

    // WHY: retry reuses the original user turn. Its disclosure is for work and
    // current error detail, not the superseded ending of a previous attempt.
    expect(turn.end).toMatchObject({
      kind: 'failed',
      cause: 'request.tools is not iterable',
    })
    expect(turn.body).toHaveLength(0)
  })

  test('a turn told not to answer says so instead of printing the placeholder', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'Continue from where you left off.' }),
      msg({ role: 'assistant', content: 'No response requested.' }),
    ])

    // WHY: the provider delivers this as ordinary assistant text, so without
    // claiming it the transcript answers the reader with the placeholder as
    // prose. It is §1's transient state — the row states it, nothing prints it.
    expect(turn.end?.kind).toBe('no-reply')
    expect(turn.body).toHaveLength(0)
    expect(turn.tail).toHaveLength(0)
  })

  test('a no-reply turn is not read as a stop, so it never borrows those words', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'ship it' }),
      msg({ role: 'assistant', content: '[No response requested]' }),
    ])

    // WHY: `cause` is what the divider prints after "Stopped". Nothing stopped
    // this run, so leaving a cause here would put the placeholder back on screen
    // in a sentence that misreports why the turn ended.
    expect(turn.end).toMatchObject({ kind: 'no-reply', cause: '', detail: '' })
  })

})
