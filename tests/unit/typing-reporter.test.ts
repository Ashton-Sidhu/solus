import { describe, expect, test } from 'bun:test'
import { TYPING_REPEAT_MS, TypingReporter } from '@solus/workspace-ui/contexts/presence/typing-reporter'
import { TYPING_EXPIRY_MS } from '@solus/server/presence/presence-manager'

// docs/plans/multiplayer-presence.md: a client reports typing from keystrokes,
// at most once per repeat interval, and the host clears the mark when the
// reports stop. The repeat must be shorter than the host's expiry, or the mark
// would flicker off while the person is still typing.

function reporter() {
  let now = 0
  const sent: [string, boolean][] = []
  const typing = new TypingReporter((key, isTyping) => sent.push([key, isTyping]), () => now)
  return { typing, sent, advance: (ms: number) => { now += ms } }
}

describe('typing reports', () => {
  test('a burst of keystrokes costs one report per repeat interval', () => {
    const { typing, sent, advance } = reporter()
    typing.keystroke('s1')
    for (let i = 0; i < 20; i++) { advance(100); typing.keystroke('s1') }
    expect(sent).toEqual([['s1', true]])
    advance(TYPING_REPEAT_MS)
    typing.keystroke('s1')
    expect(sent).toEqual([['s1', true], ['s1', true]])
  })

  test('the repeat keeps the host mark up through a burst', () => {
    expect(TYPING_REPEAT_MS).toBeLessThan(TYPING_EXPIRY_MS)
  })

  test('a stop is sent once, and only to a room that heard a start', () => {
    const { typing, sent } = reporter()
    typing.stop('s1')
    expect(sent).toEqual([])
    typing.keystroke('s1')
    typing.stop('s1')
    typing.stop('s1')
    expect(sent).toEqual([['s1', true], ['s1', false]])
  })

  test('the first keystroke after a stop is a new burst and is reported at once', () => {
    const { typing, sent, advance } = reporter()
    typing.keystroke('s1')
    typing.stop('s1')
    advance(10)
    typing.keystroke('s1')
    expect(sent).toEqual([['s1', true], ['s1', false], ['s1', true]])
  })

  test('each room has its own interval', () => {
    const { typing, sent } = reporter()
    typing.keystroke('s1')
    typing.keystroke('s2')
    expect(sent).toEqual([['s1', true], ['s2', true]])
  })
})
