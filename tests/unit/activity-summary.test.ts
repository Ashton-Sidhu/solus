import { describe, expect, test } from 'bun:test'
import { liveActivityLabel } from '../../src/renderer/components/conversation/lib/activity-summary'

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
