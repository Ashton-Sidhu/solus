import { describe, expect, test } from 'bun:test'
import type { DomainSyncState } from '@solus/client-core/freshness'
import { hostSyncNotes } from '@solus/workspace-ui/components/session/lib/host-sync-notes'

const state = (freshness: DomainSyncState['freshness'], error: string | null = null): DomainSyncState =>
  ({ freshness, error })

describe('picker host sync notes', () => {
  test('only degraded hosts earn a note; the spinner owns synchronizing', () => {
    // WHY: dispatch-client step 2 — no spinner may claim more than the ladder
    // knows, and cached rows must say they are cached. A live, error-free host
    // needs no caption; a synchronizing one is already the loading ellipsis.
    const notes = hostSyncNotes(
      new Map([
        ['ok', state('live')],
        ['busy', state('synchronizing')],
        ['asleep', state('cached')],
        ['broken', state('live', 'sync failed')],
        ['blank', state('empty', null)],
      ]),
      (serverId) => (serverId === 'asleep' ? 'Laptop' : null),
    )

    expect(notes.map((note) => note.text)).toEqual([
      'Laptop · last known',
      'broken · sync error',
      'blank · no history',
    ])
  })
})
