import { describe, expect, test } from 'bun:test'
import type { HostReadiness, HostReadinessState } from '@solus/client-core/host-readiness'
import { recordRunner } from '@solus/workspace-ui/components/session/record/lib/session-record-page'

// docs/plans/instant-share-open.md: a record whose runner this client is dialing says
// so, not "Read only". Only a runner this client keeps no copy of, or one that is
// past its grace, refused, or gone, is read only; any other label while the runner
// comes is stale. The note names the runner's state in the readiness words
// (docs/plans/host-readiness.md).

function runner(readiness: HostReadiness): { label: string; state: HostReadinessState } {
  return {
    label: 'Raiders',
    state: { readiness, away: readiness === 'unreachable' || readiness === 'refused' || readiness === 'gone', unreachableReason: readiness === 'unreachable' ? 'no-answer' : null, refusedReason: readiness === 'refused' ? 'auth' : null, lastSeenAt: null },
  }
}

describe('the record page waits on its runner only while it comes', () => {
  test('a runner that is ready or inside its grace is waited for', () => {
    for (const readiness of ['checking', 'reconnecting', 'ready'] as const) {
      expect(recordRunner(runner(readiness))).toEqual({ waits: true, note: 'Opening this session on Raiders…' })
    }
  })

  test('a runner past its grace, refused, or gone is read only and says why', () => {
    expect(recordRunner(runner('unreachable'))).toEqual({ waits: false, note: 'Read only: Raiders is offline.' })
    expect(recordRunner(runner('refused'))).toEqual({ waits: false, note: 'Read only: Raiders needs pairing again.' })
    expect(recordRunner(runner('gone')).waits).toBe(false)
  })

  test('a runner this client does not keep is read only', () => {
    expect(recordRunner(null).waits).toBe(false)
  })
})
