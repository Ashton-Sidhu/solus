import { describe, expect, test } from 'bun:test'
import { accountSyncBadge, accountSyncTone } from '@solus/workspace-ui/components/settings/lib/sync-status'

/**
 * Settings → Account & sync shows the sync state as a badge. Only a confirmed
 * sync reads as settled: an optimistic edit, a check in flight, or a stop must
 * never wear the "Synced" colour (plans/018 §5).
 */

const summary = (state: Parameters<typeof accountSyncTone>[0]) => ({ state, pendingCount: 2, conflictCount: 1, error: null })

describe('account sync badge', () => {
  test('only a confirmed sync is settled', () => {
    expect(accountSyncTone('synced')).toBe('settled')
    expect(accountSyncTone('pending')).toBe('working')
    expect(accountSyncTone('loading')).toBe('working')
    expect(accountSyncBadge(summary('pending'))).not.toBe('Synced')
  })

  test('a state the person must act on asks for attention, and a refusal reads as stopped', () => {
    expect(accountSyncTone('conflict')).toBe('attention')
    expect(accountSyncTone('offline')).toBe('attention')
    expect(accountSyncTone('error')).toBe('stopped')
  })
})
