import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab, WireNormalizedEvent } from '@solus/contracts/types'
import { StreamedProse } from '../../packages/server/src/transport/events/streamed-prose'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const BODY = 'The fix is in place.\n\nTests pass.'
const turn: WireNormalizedEvent[] = [
  { type: 'user_message', text: 'Fix it' },
  { type: 'text_chunk', text: 'The fix is in place.\n\n' },
  { type: 'text_chunk', text: 'Tests pass.' },
  { type: 'assistant_message', text: BODY },
]

function project(prose: StreamedProse, events: WireNormalizedEvent[], clients = ['desktop', 'phone']) {
  return events.map((event) => prose.project('s', event, clients, true))
}

async function webTranscript(events: WireNormalizedEvent[]) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const session = { status: 'running', messages: [] as Message[] } as Session
  const tab = { id: 'tab-1', sessionId: 's' } as Tab
  const reducer = new SessionEventReducer({
    sessions: { byId: { s: session } },
    registry: {
      tabs: { 'tab-1': tab },
      sessionFor: () => session,
      tabIdsBySession: new Map([['s', ['tab-1']]]),
    },
    settings: { rateLimitBehavior: 'ask' },
    closePlanModal: () => {},
    log: () => {},
  } as any)
  for (const event of events) reducer.apply('s', event)
  return session.messages.filter((message) => message.role === 'assistant').map((message) => message.content)
}

function mobileTranscript(events: WireNormalizedEvent[]) {
  const model = new TranscriptModel('s')
  for (const event of events) model.apply(event)
  return model.order.flatMap((id) => {
    const item = model.items.get(id)
    return item?.kind === 'assistant' ? [item.text] : []
  })
}

describe('StreamedProse', () => {
  test('sends the assembled text blank to clients that received it as chunks', () => {
    const sent = project(new StreamedProse(), turn)
    expect(sent[3]).toEqual({ type: 'assistant_message', text: '', textStreamed: true })
    expect(sent.slice(0, 3)).toEqual(turn.slice(0, 3))
  })

  test('web and mobile show the same prose from the blank event as from the whole one', async () => {
    const sent = project(new StreamedProse(), turn)
    expect(await webTranscript(sent)).toEqual(await webTranscript(turn))
    expect(await webTranscript(sent)).toEqual([BODY])
    expect(mobileTranscript(sent)).toEqual(mobileTranscript(turn))
    expect(mobileTranscript(sent)).toEqual([BODY])
  })

  test('a client that joined after the chunks gets the whole text', () => {
    const prose = new StreamedProse()
    project(prose, turn.slice(0, 3), ['desktop'])
    const [message] = project(prose, [turn[3]], ['desktop', 'phone'])
    expect(message).toEqual(turn[3])
  })

  test('a new user message forgets the prose before it', () => {
    const prose = new StreamedProse()
    project(prose, turn.slice(0, 3))
    // A provider that sends only the assembled text, after the person spoke again.
    const sent = project(prose, [{ type: 'user_message', text: 'And now?' }, { type: 'assistant_message', text: 'Done.' }])
    expect(sent[1]).toEqual({ type: 'assistant_message', text: 'Done.' })
  })

  test('a replay to one client and a sub-agent message keep their text', () => {
    const prose = new StreamedProse()
    project(prose, turn.slice(0, 3))
    expect(prose.project('s', turn[3], ['phone'], false)).toEqual(turn[3])
    const subagent: WireNormalizedEvent = { type: 'assistant_message', text: 'Found it.', parentToolUseId: 'tool-1' }
    project(prose, [{ type: 'text_chunk', text: 'Found it.', parentToolUseId: 'tool-1' }])
    expect(project(prose, [subagent])[0]).toEqual(subagent)
  })

  test('whitespace chunks do not count as prose the client holds', () => {
    const sent = project(new StreamedProse(), [
      { type: 'user_message', text: 'Hi' },
      { type: 'text_chunk', text: '\n\n' },
      { type: 'assistant_message', text: 'Hello.' },
    ])
    expect(sent[2]).toEqual({ type: 'assistant_message', text: 'Hello.' })
  })
})
