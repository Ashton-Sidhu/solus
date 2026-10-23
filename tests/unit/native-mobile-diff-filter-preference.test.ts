import { expect, test } from 'bun:test'
import { DiffFilterPreference } from '../../apps/mobile/src/features/review/diff-filter-preference'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'

test('native diffs restore the saved classification after closing or restarting', () => {
  const storage = memoryKeyValueStore()
  const preference = new DiffFilterPreference(storage)
  expect(preference.current()).toBeNull()
  let notifications = 0
  preference.changes.subscribe(() => notifications++)
  preference.set(['tests'])
  expect(new DiffFilterPreference(storage).current()).toEqual(['tests'])
  expect(notifications).toBe(1)
  preference.set(null)
  expect(new DiffFilterPreference(storage).current()).toBeNull()
  expect(storage.getItem('solus-diff-kind')).toBe('null')
})

test('an invalid saved classification shows all files on mobile', () => {
  const storage = memoryKeyValueStore()
  storage.setItem('solus-diff-kind', 'removed-class')
  expect(new DiffFilterPreference(storage).current()).toBeNull()
})

test('multiple classes and no classes survive reopening', () => {
  const storage = memoryKeyValueStore()
  const preference = new DiffFilterPreference(storage)
  preference.set(['code', 'docs'])
  expect(new DiffFilterPreference(storage).current()).toEqual(['code', 'docs'])
  preference.set([])
  expect(new DiffFilterPreference(storage).current()).toEqual([])
  expect(preference.current()).toBe(preference.current())
})
