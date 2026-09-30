import type { Activity, ActivityKind } from '@solus/contracts/activity'
import { afterAll, describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { buildTurns, groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { messageTurnIds } from '@solus/workspace-ui/components/conversation/lib/transcript-navigation'
import { SvelteRunes } from './helpers/svelte-runes'

// WHY: the conversation view builds turns one segment at a time so a streamed
// token or a new tool call costs one segment, not the whole transcript. That is
// only safe if the result is exactly what one whole-transcript build gives, and
// only useful if the untouched segments really are left alone.

const runes = new SvelteRunes()
afterAll(() => runes.dispose())

const turnsFile = SvelteRunes.file('packages/workspace-ui/src/components/conversation/lib/turns.ts')
const counted = runes.module('turns-counted', `
  import * as turns from ${JSON.stringify(turnsFile)}
  export * from ${JSON.stringify(turnsFile)}
  export const calls = { group: 0, grouped: 0, build: 0 }
  export function groupMessages(messages) { calls.group++; calls.grouped += messages.length; return turns.groupMessages(messages) }
  export function buildTurns(items, opts) { calls.build++; return turns.buildTurns(items, opts) }
`)
const navigation = runes.source('navigation',
  'packages/workspace-ui/src/components/conversation/lib/transcript-navigation.ts', { './turns': turnsFile })
const transcriptModule = runes.source('transcript-turns',
  'packages/workspace-ui/src/components/conversation/lib/transcript-turns.svelte.ts', {
    './turns': counted,
    './transcript-navigation': navigation,
    './artifact-revisions': SvelteRunes.file('packages/workspace-ui/src/components/conversation/lib/artifact-revisions.ts'),
  })
const fixture = runes.module('fixture', `
  import { flushSync } from 'svelte'
  import { TranscriptTurns } from ${JSON.stringify(transcriptModule)}
  // The view reads turns from its template, which is an effect: read them the
  // same way, so the deriveds cache and invalidate as they do in the app.
  export function create(messages, running) {
    const state = $state({ messages, running })
    const transcript = new TranscriptTurns(() => state.messages, () => state.running)
    let sink = 0
    $effect.root(() => { $effect(() => {
      sink += transcript.turns.length + (transcript.messageTurns.get('') ? 1 : 0)
      for (const segment of transcript.segments) sink += segment.artifacts.length
    }) })
    flushSync()
    return { state, transcript, flush: flushSync }
  }
`)
const { create } = await import(fixture) as {
  create(messages: Message[], running: boolean): {
    state: { messages: Message[]; running: boolean }
    flush(): void
    transcript: {
      turns: ReturnType<typeof buildTurns>
      segments: Array<{ turns: unknown; artifacts: unknown[] }>
      messageTurns: { get(messageId: string): string | undefined }
    }
  }
}
const { calls } = await import(counted) as { calls: { group: number; grouped: number; build: number } }

const ORIGIN: NonNullable<Message['agentConversationRef']>['origin'] = 'created'
let clock = 1_000
/** A thread-dividing activity as the host sends it (plans/012 §5). */
function divider(kind: ActivityKind): Activity {
  return { ...kind, id: `a-${kind.kind}`, subject: { kind: 'session', id: 's' }, at: 1, by: { kind: 'system' } }
}

function msg(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  clock += 1_000
  return { id: `m${clock}`, content: '', timestamp: clock, ...partial }
}
function tool(name: string, extra: Partial<Message> = {}): Message {
  const call = msg({ role: 'tool', toolName: name, toolInput: '{}', ...extra })
  return { toolStatus: 'completed', toolCompletedAt: call.timestamp + 500, ...call }
}

/** Every shape that opens, continues, or closes a turn or a card group. */
function varietyTranscript(): Message[] {
  return [
    msg({ role: 'assistant', content: 'Resumed without a prompt.' }),
    tool('Read'),
    msg({ role: 'user', content: 'fix the build' }),
    msg({ role: 'assistant', content: 'Looking.', thoughts: ['Start with the log'] }),
    tool('Bash'),
    tool('Task', { subMessages: [], toolStatus: 'completed' }),
    tool('Edit'),
    tool('Task', { subMessages: [] }),
    msg({ role: 'assistant', content: 'Fixed.' }),
    msg({ role: 'system', content: '', activity: divider({ kind: 'agent_switched', provider: 'codex' }) }),
    msg({ role: 'user', content: 'now the docs' }),
    msg({ role: 'assistant', content: '', workRef: { workId: 'w1', title: 'Plan', workType: 'doc' } }),
    msg({ role: 'system', content: '', taskRef: { taskId: 't1', title: 'Follow up', url: null } }),
    msg({ role: 'assistant', content: 'Filed it.' }),
    msg({ role: 'user', content: 'and again' }),
    tool('Read'),
    msg({ role: 'system', content: '[Request interrupted by user]' }),
    msg({ role: 'user', content: '[Request interrupted by user]' }),
    msg({ role: 'user', content: 'try once more' }),
    msg({ role: 'assistant', content: '', agentConversationRef: { agentSessionId: 's2', provider: 'codex', title: 'Review', cwd: '/repo', origin: ORIGIN } }),
    tool('AskUserQuestion', { toolStatus: 'completed' }),
    msg({ role: 'assistant', content: 'Error: 529 overloaded' }),
    msg({ role: 'system', content: 'Error: 529 overloaded' }),
    msg({ role: 'user', content: 'run it' }),
    tool('Bash'),
    msg({ role: 'user', content: 'actually skip tests', delivery: 'steer' }),
    tool('Bash', { toolStatus: 'running' }),
  ]
}

function wholeBuild(messages: Message[], running: boolean) {
  return buildTurns(groupMessages(messages), { running })
}

describe('segment-local turns', () => {
  test('equal one whole-transcript build, running or settled', () => {
    for (const running of [false, true]) {
      const messages = varietyTranscript()
      const { transcript } = create(messages, running)
      expect(JSON.parse(JSON.stringify(transcript.turns))).toEqual(JSON.parse(JSON.stringify(wholeBuild(messages, running))))
    }
  })

  test('equal one whole-transcript build for any order of message shapes', () => {
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let round = 0; round < 300; round++) {
      const pool = varietyTranscript()
      const messages = Array.from({ length: 5 + Math.floor(random() * 40) }, () => {
        const shape = pool[Math.floor(random() * pool.length)]
        return msg({ ...shape, role: shape.role })
      })
      const running = random() < 0.5
      const { transcript } = create(messages, running)
      expect(JSON.parse(JSON.stringify(transcript.turns))).toEqual(JSON.parse(JSON.stringify(wholeBuild(messages, running))))
    }
  })

  test('a steered prompt keeps the turn it interrupted live across segments', () => {
    const messages = varietyTranscript()
    const { transcript } = create(messages, true)
    const live = transcript.turns.filter((turn) => turn.live).map((turn) => turn.id)
    expect(live).toEqual(wholeBuild(messages, true).filter((turn) => turn.live).map((turn) => turn.id))
    expect(live.length).toBe(2)
  })

  test('a streamed token regroups only its own segment and rebuilds no turn', () => {
    const { state, transcript, flush } = create([...varietyTranscript(),
      msg({ role: 'user', content: 'last' }), msg({ role: 'assistant', content: 'Streaming' })], true)
    const before = transcript.turns
    const segments = transcript.segments
    const start = { ...calls }

    state.messages[state.messages.length - 1].content += ' more text'
    flush()
    const after = transcript.turns

    expect(after).toBe(before)
    expect(transcript.segments).toBe(segments)
    expect(calls.group - start.group).toBe(1)
    expect(calls.grouped - start.grouped).toBe(2)
    expect(calls.build - start.build).toBe(0)
  })

  test('a new message rebuilds only the segment it lands in; settled turns keep their identity', () => {
    const { state, transcript, flush } = create(varietyTranscript(), true)
    const before = transcript.turns
    const settledSegments = transcript.segments.slice(0, -1)
    const start = { ...calls }

    state.messages.push(tool('Read'))
    flush()
    const after = transcript.turns

    expect(transcript.segments.slice(0, -1)).toEqual(settledSegments)
    for (let i = 0; i < settledSegments.length; i++) expect(transcript.segments[i]).toBe(settledSegments[i])
    for (let i = 0; i < before.length - 1; i++) expect(after[i]).toBe(before[i])
    expect(calls.group - start.group).toBe(1)
    expect(calls.build - start.build).toBe(1)
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(wholeBuild(state.messages, true))))
  })

  test('the run ending re-folds only the live segments', () => {
    const { state, transcript, flush } = create(varietyTranscript(), true)
    const start = { ...calls }
    state.running = false
    flush()
    const settled = transcript.turns
    expect(calls.build - start.build).toBe(2)
    expect(settled.every((turn) => !turn.live)).toBe(true)
  })

  test('a prepended page, a released page, and a wholesale replacement all re-cut to the whole build', () => {
    const history = varietyTranscript()
    const { state, transcript, flush } = create(history.slice(-8), false)
    state.messages.unshift(...history.slice(0, -8))
    flush()
    expect(JSON.parse(JSON.stringify(transcript.turns))).toEqual(JSON.parse(JSON.stringify(wholeBuild(state.messages, false))))
    state.messages.splice(0, history.length - 8)
    flush()
    expect(JSON.parse(JSON.stringify(transcript.turns))).toEqual(JSON.parse(JSON.stringify(wholeBuild(state.messages, false))))
    const replacement = varietyTranscript().slice(-8)
    state.messages.splice(0, state.messages.length, ...replacement)
    flush()
    expect(transcript.turns.flatMap((turn) => turn.lead ? [turn.lead] : []).map((item) => 'message' in item ? item.message.id : ''))
      .toEqual(wholeBuild(replacement, false).flatMap((turn) => turn.lead ? [turn.lead] : []).map((item) => 'message' in item ? item.message.id : ''))
  })

  test('the message → turn index follows appends without a whole-transcript rebuild', () => {
    // WHY: Find and the message navigator jump to a message's turn; the index
    // must stay right as messages arrive, and must not cost every message.
    const { state, transcript, flush } = create(varietyTranscript(), true)
    state.messages.push(tool('Read'), msg({ role: 'user', content: 'next' }), msg({ role: 'assistant', content: 'ok' }))
    flush()
    const expected = messageTurnIds(wholeBuild(state.messages, true))
    for (const message of state.messages) expect(transcript.messageTurns.get(message.id)).toBe(expected.get(message.id))
  })

  test('a streamed token keeps the segment artifact lists, so the artifact index does not recompute', () => {
    const artifact = msg({ role: 'assistant', content: '```html render artifact=chart\n<p>One</p>\n```\n' })
    const { state, transcript, flush } = create([msg({ role: 'user', content: 'draw' }), artifact, msg({ role: 'assistant', content: 'Now' })], true)
    const before = transcript.segments.map((segment) => segment.artifacts)
    expect(before.flat()).toHaveLength(1)
    state.messages[state.messages.length - 1].content += ' more'
    flush()
    expect(transcript.segments.map((segment) => segment.artifacts)).toEqual(before)
    for (let i = 0; i < before.length; i++) expect(transcript.segments[i].artifacts).toBe(before[i])
  })
})
