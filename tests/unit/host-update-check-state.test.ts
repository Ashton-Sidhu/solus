import { expect, test } from 'bun:test'
import { reduceCheckState } from '@solus/server/updates/check-state'

test('checks compare releases and preserve known versions after a failed source', () => {
  const available = reduceCheckState({ kind: 'idle', reason: null }, { kind: 'result', current: '1.0.0', latest: '1.1.0', now: 10 })
  expect(available).toEqual({ kind: 'available', latestVersion: '1.1.0', checkedAt: 10 })
  expect(reduceCheckState(available, { kind: 'check' })).toEqual({ kind: 'checking' })
  expect(reduceCheckState({ kind: 'checking' }, { kind: 'error', message: 'Offline', latestVersion: '1.1.0', now: 20 })).toEqual({ kind: 'error', message: 'Offline', latestVersion: '1.1.0', checkedAt: 20 })
  expect(reduceCheckState(available, { kind: 'result', current: '1.2.0', latest: '1.1.0', now: 30 }).kind).toBe('up-to-date')
})

test('uncheckable software has an explicit reason', () => {
  for (const reason of ['Development build', 'Not installed']) expect(reduceCheckState({ kind: 'checking' }, { kind: 'idle', reason })).toEqual({ kind: 'idle', reason })
})
