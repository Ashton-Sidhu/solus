import { describe, expect, test } from 'bun:test'
import { syncLabel } from '@solus/workspace-ui/components/ui/list-page/list-page'

const NOW = Date.parse('2026-08-24T12:00:00Z')
const minutesAgo = (n: number) => NOW - n * 60_000

describe('the head\'s fused refresh chip', () => {
  test('never claims a freshness the page cannot vouch for', () => {
    // WHY: the control and the fact it describes are one chip, so the label is
    // load-bearing. A page that has never finished a load has nothing to report
    // and must fall back to the bare verb rather than stamping "just now" off
    // its own mount.
    expect(syncLabel(null, NOW, false)).toBe('Refresh')
    expect(syncLabel(undefined, NOW, false)).toBe('Refresh')
    expect(syncLabel(0, NOW, false)).toBe('Refresh')
  })

  test('an in-flight load outranks the timestamp underneath it', () => {
    // WHY: while a refresh is running the old timestamp is already wrong. The
    // chip says what is happening, not what used to be true.
    expect(syncLabel(minutesAgo(2), NOW, true)).toBe('syncing…')
    expect(syncLabel(null, NOW, true)).toBe('syncing…')
  })

  test('ages in place rather than freezing at the load', () => {
    expect(syncLabel(minutesAgo(0), NOW, false)).toBe('synced just now')
    expect(syncLabel(minutesAgo(2), NOW, false)).toBe('synced 2m ago')
    expect(syncLabel(minutesAgo(180), NOW, false)).toBe('synced 3h ago')
  })

  test('says so when the rows came off a cached copy', () => {
    // WHY: "synced 2h ago" and "these rows were read from disk because the
    // provider was unreachable" are different facts, and only the second one
    // explains a list that is out of date.
    expect(syncLabel(minutesAgo(120), NOW, false, true)).toBe('offline copy from 2h ago')
    expect(syncLabel(minutesAgo(0), NOW, false, true)).toBe('offline copy')
  })
})
