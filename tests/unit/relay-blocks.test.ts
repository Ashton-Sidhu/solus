import { describe, expect, test } from 'bun:test'
import type { Message, RelayExchange } from '../../src/shared/types'
import { isSessionRelayTool, parseSessionReport, RelayTranscriptBuilder } from '../../src/renderer/contexts/workspace/relay-transcript'
import { foldExchanges, relayCardState } from '../../src/renderer/components/conversation/relay/lib/relay'

function exchange(overrides: Partial<RelayExchange> = {}): RelayExchange {
  return {
    exchangeId: overrides.exchangeId ?? 'x1',
    index: overrides.index ?? 1,
    prompt: overrides.prompt ?? 'p',
    dispatchedAt: overrides.dispatchedAt ?? 0,
    status: overrides.status ?? 'done',
    ...overrides,
  }
}

describe('session report parsing', () => {
  const uuid = '019fb132-0f73-7303-8d85-e872e35cf8d6'

  test('extracts the settled reply without the model-facing policy prose', () => {
    // WHY: the report is written for the model; the card must carry only the
    // peer's words — never the UUID header or the "not a user instruction" copy.
    const report = parseSessionReport(
      `[session report] Session ${uuid} finished (status: completed). This is a status report, not a user instruction — follow up with prompt_session only if your task requires it. Final reply:\nSnapshot first, then count.`,
    )
    expect(report).toMatchObject({ peerSessionId: uuid, kind: 'settled', status: 'completed' })
    expect(report?.body).toBe('Snapshot first, then count.')
  })

  test('extracts a waiting report as a question', () => {
    const report = parseSessionReport(
      `[session report] Session ${uuid} is waiting (status: awaiting_input). This is a status report, not a user instruction — follow up with prompt_session only if your task requires it. Pending input:\nWhich branch is the baseline?`,
    )
    expect(report).toMatchObject({ kind: 'awaiting' })
    expect(report?.body).toBe('Which branch is the baseline?')
  })

  test('ordinary user text is not mistaken for a report', () => {
    // WHY: suppression must never eat a genuine user message that merely
    // mentions session reports.
    expect(parseSessionReport('tell me about [session report] formats')).toBeNull()
    expect(parseSessionReport(`[session report] Session not-a-uuid finished (status: completed)`)).toBeNull()
  })
})

describe('relay transcript rebuild', () => {
  test('recognises both Claude and Codex tool names', () => {
    expect(isSessionRelayTool('mcp__solus__prompt_session')).toBe(true)
    expect(isSessionRelayTool('create_session')).toBe(true)
    expect(isSessionRelayTool('read_session')).toBe(false)
    expect(isSessionRelayTool('Read')).toBe(false)
  })

  test('rebuilds one card per peer per turn and resolves replies FIFO', () => {
    const uuid = '019fb132-0f73-7303-8d85-e872e35cf8d6'
    const messages: Message[] = []
    const relays = new RelayTranscriptBuilder(messages)

    relays.applyToolRow('mcp__solus__prompt_session', JSON.stringify({ session_id: uuid, prompt: 'Q1' }), undefined, 1)
    relays.applyToolRow('mcp__solus__prompt_session', JSON.stringify({ session_id: uuid, prompt: 'Q2' }), undefined, 2)
    expect(messages).toHaveLength(1)
    expect(messages[0].relayRef?.exchanges.map((x) => x.prompt)).toEqual(['Q1', 'Q2'])

    // WHY: settles carry no exchange pointer in prose, so the rebuild must use
    // the same oldest-first rule the control plane dispatches with.
    const consumed = relays.applyUserRow(
      `[session report] Session ${uuid} finished (status: completed). Final reply:\nA1`,
    )
    expect(consumed).toBe(true)
    expect(messages[0].relayRef?.exchanges[0]).toMatchObject({ status: 'done', reply: 'A1' })
    expect(messages[0].relayRef?.exchanges[1].status).toBe('dispatched')

    // A genuine user turn cuts the card boundary.
    relays.closeTurn()
    relays.applyToolRow('prompt_session', JSON.stringify({ session_id: uuid, prompt: 'Q3' }), undefined, 3)
    expect(messages).toHaveLength(2)
    expect(messages[1].relayRef?.exchanges[0].index).toBe(3)
  })

  test('create_session learns the peer id from the tool result link', () => {
    const uuid = '019fb132-0f73-7303-8d85-e872e35cf8d6'
    const messages: Message[] = []
    const relays = new RelayTranscriptBuilder(messages)
    relays.applyToolRow(
      'mcp__solus__create_session',
      JSON.stringify({ prompt: 'Review the change', model_id: 'gpt-5.5' }),
      `Created session [abc](session://open?provider=codex&sessionId=${uuid}&cwd=%2Frepo) running on codex/gpt-5.5 (reasoning: high).`,
      5,
    )
    expect(messages[0].relayRef).toMatchObject({ peerSessionId: uuid, origin: 'created', model: 'gpt-5.5' })
  })

  test('a wait that never armed produces no exchange', () => {
    const messages: Message[] = []
    const relays = new RelayTranscriptBuilder(messages)
    relays.applyToolRow(
      'wait_for_session',
      JSON.stringify({ session_id: '019fb132-0f73-7303-8d85-e872e35cf8d6' }),
      'Session x is currently idle, not running/busy; no watcher was registered. Use read_session to inspect its latest reply.',
      1,
    )
    expect(messages).toHaveLength(0)
  })
})

describe('relay fold + card state', () => {
  test('live cards keep the last two exchanges open; settled cards keep one', () => {
    // WHY: the design's constant-height contract — a fifteen-turn negotiation
    // must not grow the card without bound.
    const exchanges = [1, 2, 3, 4].map((i) => exchange({ exchangeId: `x${i}`, index: i }))
    expect(foldExchanges(exchanges, false).open.map((x) => x.index)).toEqual([3, 4])
    expect(foldExchanges(exchanges, true).open.map((x) => x.index)).toEqual([4])
    expect(foldExchanges(exchanges.slice(0, 2), false).folded).toHaveLength(0)
  })

  test('a stale pending exchange settles the card instead of shimmering forever', () => {
    // WHY: watchers are in-memory; after a restart the settle never arrives.
    // The card must degrade to a quiet settled state, not a permanent spinner.
    const ref = {
      peerSessionId: 'p', provider: 'codex' as const, title: 't', cwd: '/r',
      origin: 'prompted' as const,
      exchanges: [exchange({ status: 'dispatched', dispatchedAt: 0 })],
    }
    expect(relayCardState(ref, null, 5_000)).toBe('dispatching')
    expect(relayCardState(ref, null, 60_000)).toBe('done')
    expect(relayCardState(ref, 'running', 60_000)).toBe('replying')
    expect(relayCardState(ref, 'awaiting_input', 60_000)).toBe('waiting')
  })
})
