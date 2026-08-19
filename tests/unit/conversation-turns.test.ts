import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import {
  buildTurns,
  groupMessages,
  hasVisibleTurnBody,
  itemKey,
  needsLiveRow,
  runIsLive,
  shouldAnimateTurnEntry,
  stabilizeTurns,
} from '@solus/workspace-ui/components/conversation/lib/turns'

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

  test('keeps an agent-change divider outside the preceding turn fold', () => {
    const turns = turnsFor([
      msg({ role: 'user', content: 'fix the bug' }),
      msg({ role: 'assistant', content: 'Fixed.' }),
      msg({
        role: 'system',
        content: 'Switched to Claude Code',
        agentChangedTo: 'Claude Code',
      }),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[1].lead?.kind).toBe('system')
    expect(
      turns[1].lead?.kind === 'system' && turns[1].lead.message.agentChangedTo,
    ).toBe('Claude Code')
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
        agentConversationRef: {
          agentSessionId: 'session-1',
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
      'agent-conversation-group',
      'document',
    ])
    expect(turn.tail.map((item) => item.kind)).toEqual(['assistant'])
  })

  test('a stopped turn still hands back the work it did before the stop', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'plan the exchange protocol' }),
      tool('Grep', '{"pattern":"agentExchange"}'),
      msg({ role: 'assistant', content: 'Here is what I found.' }),
      msg({ role: 'system', content: '[Request interrupted by user]' }),
    ])

    // WHY: reviewing a plan stops the run that produced it. The stop is an event
    // that closed the turn, not a description of it, so the turn keeps the shape
    // every other finished turn has — a summary row over the work it discloses,
    // with the ending stated after. Collapsing the two loses the transcript.
    expect(turn.end?.kind).toBe('stopped')
    expect(turn.end?.cause).toBe('by you')
    expect(turn.body.map((item) => item.kind)).toEqual(['tool-group'])
    expect(turn.tail.map((item) => item.kind)).toEqual(['assistant'])
    expect(hasVisibleTurnBody(turn)).toBe(true)
  })

  test('keeps the plan on screen after the turn that produced it collapses', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'plan the exchange protocol' }),
      tool('Grep', '{"pattern":"agentExchange"}'),
      msg({ role: 'plan', planId: 'agent-session-1__plan-tool-1' }),
      msg({ role: 'system', content: '[Request interrupted by user]' }),
    ])

    // WHY: the plan is the outcome the reader still has to accept or revise, not
    // a step taken on the way there. Folding it away with the tool calls leaves
    // the decision with nothing to decide about.
    expect(turn.visibleWhenCollapsed.map((item) => item.kind)).toEqual(['plan'])
  })

  test('a new-session divider opens its own turn instead of joining the previous fold', () => {
    const turns = turnsFor([
      msg({ role: 'user', content: 'plan the exchange protocol' }),
      tool('Grep', '{"pattern":"agentExchange"}'),
      msg({ role: 'system', newSessionForPlanId: 'agent-session-1__plan-tool-1' }),
      msg({ role: 'user', content: 'Implement this plan: …' }),
    ])

    // WHY: accepting a plan restarts on a fresh agent session that carries none
    // of the planning context. That boundary is a statement about the thread, so
    // no turn fold may hide it — otherwise a deliberate reset is indistinguishable
    // from the conversation losing its memory.
    expect(turns).toHaveLength(3)
    expect(turns[1].lead?.kind === 'system' && turns[1].lead.message.newSessionForPlanId)
      .toBe('agent-session-1__plan-tool-1')
  })

  test('a turn\'s agent-conversation cards stack at the first dispatch despite interleaved tool rows', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'brief all three' }),
      tool('mcp__solus__prompt_session', '{"session_id":"a"}'),
      msg({
        role: 'assistant',
        agentConversationRef: { agentSessionId: 'a', provider: 'codex', title: 'A', cwd: '/r', origin: 'prompted', exchanges: [] },
      }),
      tool('mcp__solus__prompt_session', '{"session_id":"b"}'),
      msg({
        role: 'assistant',
        agentConversationRef: { agentSessionId: 'b', provider: 'claude-code', title: 'B', cwd: '/r', origin: 'prompted', exchanges: [] },
      }),
      msg({ role: 'assistant', content: 'Briefed both.' }),
    ])

    // WHY: several agents dispatched by one decision are one roster, not two
    // cards separated by their own plumbing rows — the stack anchors where the
    // first dispatch happened and later dispatches join it in place.
    const agentConversationGroups = turn.body.filter((item) => item.kind === 'agent-conversation-group')
    expect(agentConversationGroups).toHaveLength(1)
    expect(
      agentConversationGroups[0].kind === 'agent-conversation-group'
        ? agentConversationGroups[0].messages.map((m) => m.agentConversationRef?.agentSessionId)
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

  test('a rate limit reported as the turn lands does not fold the answer away', () => {
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'rescope the spec' }),
      tool('Read', '{"file_path":"spec.md"}'),
      msg({ role: 'assistant', content: 'Rescoped — it now reads as a build plan.' }),
      msg({ role: 'system', content: 'Rate limit warning (seven_day).', rateLimitNotice: true }),
    ])

    // The notice is a fact about the run, so it must not be read as the end of
    // the answer — the answer stays on screen and the notice sits under it.
    expect(turn.body.map((item) => item.kind)).toEqual(['tool-group'])
    expect(turn.tail.map((item) => item.kind)).toEqual(['assistant', 'system'])
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

describe('a run parked on a card has not ended', () => {
  test('keeps the turn live while a question, permission or plan is unanswered', () => {
    // WHY: the pending tool call is the last thing in the turn, so nothing lands
    // in `tail`. Reading these statuses as "ended" folds the whole turn — the
    // reasoning the card asks the reader about vanishes behind a summary row and
    // only comes back once they answer, which is the one moment they need it.
    expect(runIsLive('awaiting_input', false)).toBe(true)
    expect(runIsLive('awaiting_plan', false)).toBe(true)
    expect(runIsLive('running', false)).toBe(true)
  })

  test('a settled run folds, and text still streaming holds the fold off', () => {
    expect(runIsLive('completed', false)).toBe(false)
    expect(runIsLive('completed', true)).toBe(true)
  })

  test('the pending tool call leaves nothing in the tail to save the narration', () => {
    // WHY: this is the shape the fix guards. If `running` were false here the
    // reader would be left with a summary row and the question card alone.
    const [turn] = turnsFor([
      msg({ role: 'user', content: 'snapshot or hold?' }),
      msg({ role: 'assistant', content: 'Two ways to go about this.' }),
      tool('AskUserQuestion', '{"questions":[]}', false),
    ], true)

    expect(turn.tail).toHaveLength(0)
    expect(turn.live).toBe(true)
  })
})

describe('shouldAnimateTurnEntry — history paints as one transcript', () => {
  test('does not animate completed turns mounted by transcript hydration', () => {
    const turns = turnsFor([
      msg({ role: 'user', content: 'Question' }),
      msg({ role: 'assistant', content: 'Answer' }),
    ], false)

    // WHY: animating a bulk-loaded turn lets its simpler assistant row paint
    // before the user bubble finishes mounting, so the transcript looks reordered.
    expect(shouldAnimateTurnEntry(turns[0], 0, turns.length)).toBe(false)
  })

  test('animates only recent turns while the run is live', () => {
    const turns = turnsFor([
      msg({ role: 'user', content: 'First' }),
      msg({ role: 'assistant', content: 'First answer' }),
      msg({ role: 'user', content: 'Second' }),
      msg({ role: 'assistant', content: 'Second answer' }),
      msg({ role: 'user', content: 'Third' }),
    ], true)

    expect(turns.map((turn, index) => shouldAnimateTurnEntry(turn, index, turns.length)))
      .toEqual([false, false, true])
  })
})

describe('stabilizeTurns — settled turns keep their identity across streaming rebuilds', () => {
  test('an unchanged turn returns the previous object; the changed live turn stays fresh', () => {
    // WHY: the reveal cursor rebuilds turns ~30×/s while text streams. Each row
    // component keys its derived work on the `turn` prop's identity, so handing
    // every settled turn a fresh object each frame re-runs per-turn derived
    // state across the whole transcript for a one-character reveal step.
    const settled = [
      msg({ role: 'user', content: 'first prompt' }),
      msg({ role: 'assistant', content: 'first answer' }),
    ]
    const livePrompt = msg({ role: 'user', content: 'second prompt' })
    const grouped = groupMessages([...settled, livePrompt])

    const frameOne = buildTurns(grouped, { running: true })
    const frameTwo = stabilizeTurns(
      buildTurns(
        [...grouped, { kind: 'live-assistant' as const, id: 'live-stream', content: 'strea' }],
        { running: true },
      ),
      frameOne,
    )

    expect(frameTwo[0]).toBe(frameOne[0])
    expect(frameTwo[1]).not.toBe(frameOne[1])
    expect(frameTwo[1].body.at(-1)).toMatchObject({ kind: 'live-assistant', content: 'strea' })
  })

  test('a turn whose end changed is not reused', () => {
    const prompt = msg({ role: 'user', content: 'do the thing' })
    const grouped = groupMessages([prompt])
    const running = buildTurns(grouped, { running: true })
    const stopped = stabilizeTurns(buildTurns(grouped, { running: false }), running)
    expect(stopped[0]).not.toBe(running[0])
    expect(stopped[0].live).toBe(false)
  })
})
