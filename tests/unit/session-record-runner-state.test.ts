import { describe, expect, test } from 'bun:test'
import { recordRunnerState } from '@solus/workspace-ui/components/session/record/lib/session-record-page'

// docs/plans/instant-share-open.md: a record whose runner this client is dialing says
// "Connecting", not "Read only". Only a runner this client keeps no copy of, does not
// dial, or cannot reach is read only; any other label while the runner comes is stale.

describe('the record page waits on its runner only while it comes', () => {
  test('a saved runner being dialed, or reached and opening, is connecting', () => {
    expect(recordRunnerState('host-a', 'connecting')).toBe('connecting')
    expect(recordRunnerState('host-a', 'reconnecting')).toBe('connecting')
    expect(recordRunnerState('host-a', 'connected')).toBe('connecting')
  })

  test('a runner that is offline, refused, never dialed, or not kept here is away', () => {
    expect(recordRunnerState('host-a', 'offline')).toBe('away')
    expect(recordRunnerState('host-a', 'blocked')).toBe('away')
    expect(recordRunnerState('host-a', undefined)).toBe('away')
    expect(recordRunnerState(null, 'connecting')).toBe('away')
  })
})
