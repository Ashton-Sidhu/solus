import { describe, expect, test } from 'bun:test'
import {
  getToolDescription,
  liveActivityLabel,
} from '../../src/renderer/components/conversation/lib/activity-summary'

describe('liveActivityLabel', () => {
  test('keeps fast startup phases visible before the agent begins thinking', () => {
    // WHY: the transport can report running almost immediately. Without a short
    // presentation window, users only ever see the unhelpful thinking fallback.
    expect(liveActivityLabel('Thinking...', 500, false, 'fresh')).toBe('Getting things ready…')
    expect(liveActivityLabel('Thinking...', 2_000, false, 'fresh')).toBe('Connecting to your agent…')
    expect(liveActivityLabel('Thinking...', 4_000, false, 'fresh')).toBe('Thinking it through…')
  })

  test('does not make an established session sound disconnected', () => {
    expect(liveActivityLabel('Resuming...', 500, false, 'follow_up')).toBe('Picking this back up…')
    expect(liveActivityLabel('Thinking...', 2_000, false, 'follow_up')).toBe('Thinking it through…')
  })

  test('acknowledges steering as a change to the active run', () => {
    expect(liveActivityLabel('Thinking...', 500, false, 'steer')).toBe('Adjusting course…')
  })

  test('describes the pause between tool calls as planning the next step', () => {
    expect(liveActivityLabel('Thinking...', 0, true)).toBe('Planning the next step…')
  })
})

describe('getToolDescription', () => {
  test('shows arguments for bare Codex Solus tools', () => {
    // WHY: repeated Solus calls are indistinguishable in the activity trace
    // when their query or target is hidden.
    expect(
      getToolDescription(
        'search_sessions',
        JSON.stringify({ query: 'host selection', role: 'any', limit: 10 }),
        { truncate: false },
      ),
    ).toBe('search_sessions: {"query":"host selection","role":"any","limit":10}')
  })

  test('shows the same arguments for Claude-prefixed Solus tools', () => {
    expect(
      getToolDescription(
        'mcp__solus__read_session',
        JSON.stringify({ session_id: 'session-123', tail: 20 }),
        { truncate: false },
      ),
    ).toBe('read_session: {"session_id":"session-123","tail":20}')
  })

  test('keeps argument-free Solus tools concise', () => {
    expect(getToolDescription('list_sessions', '{}', { truncate: false })).toBe('list_sessions')
  })
})
