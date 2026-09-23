import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import {
  firstActivityAt,
  withLazyActivity,
} from '@solus/workspace-ui/contexts/workspace/session-activity'
import { sessionTitle } from '@solus/workspace-ui/lib/sessionUtils'

type TranscriptMessage = { role: string; content: string; timestamp?: number }

/**
 * A transcript that records which keys are read. Svelte's `$state` proxy
 * subscribes a reader to exactly the keys it reads, so a helper that reads
 * `length` subscribes the sidebar's whole column to every streamed message.
 */
function recordedSession(messages: TranscriptMessage[], title = '') {
  const reads = new Set<PropertyKey>()
  const transcript = new Proxy(messages, {
    get(target, key, receiver) {
      reads.add(key)
      return Reflect.get(target, key, receiver)
    },
  })
  // SAFETY: the helpers under test read only `title` and `messages`.
  const session = { title, messages: transcript } as unknown as Session
  return { session, reads }
}

describe('session activity for the sidebar column', () => {
  test('the first dated message is found without subscribing to transcript length', () => {
    // WHY: the column reads this for every open session. Reading `length`
    // rebuilt every row on every streamed message of any session.
    const { session, reads } = recordedSession([
      { role: 'system', content: '' },
      { role: 'user', content: 'Fix the sidebar', timestamp: 1_000 },
      { role: 'assistant', content: 'On it', timestamp: 2_000 },
    ])
    expect(firstActivityAt(session)).toBe(1_000)
    expect(reads.has('length')).toBe(false)
    expect(reads.has('2')).toBe(false)
  })

  test('a session with no dated message sorts as the newest', () => {
    const { session, reads } = recordedSession([])
    expect(firstActivityAt(session)).toBe(Number.MAX_SAFE_INTEGER)
    expect(reads.has('length')).toBe(false)
  })

  test("an untitled session's name comes from its prompt without subscribing to length", () => {
    // WHY: a new session has no title until one is generated, which is exactly
    // when its row is arriving and the column must stay still.
    const { session, reads } = recordedSession([
      { role: 'user', content: 'Make  the\nsidebar flat' },
      { role: 'assistant', content: 'Done' },
    ])
    expect(sessionTitle(session)).toBe('Make the sidebar flat')
    expect(reads.has('length')).toBe(false)
  })

  test('a row built with lazy activity reads the transcript only when asked', () => {
    // WHY: child rows are built in the column's derived pass; only pickers ask
    // when a session was last active, so only they may depend on each message.
    let asked = 0
    const row = withLazyActivity({ tabId: 'tab-1' }, () => {
      asked++
      return 5_000
    })
    expect(asked).toBe(0)
    expect(row.lastActivityAt).toBe(5_000)
    expect(asked).toBe(1)
    // A picker that copies the row still gets the value.
    expect({ ...row }.lastActivityAt).toBe(5_000)
  })
})
