import { expect, test } from 'bun:test'
import { upsertById } from '@solus/client-core/keep-equal'

/**
 * A store applies one pushed record to the list it holds: an automation's runs,
 * a webhook's deliveries, a session's MCP tasks, a host's integrations.
 */

test('a changed record keeps its place, so its row does not jump', () => {
  const list = [{ id: 'a', state: 'running' }, { id: 'b', state: 'running' }]
  expect(upsertById(list, { id: 'a', state: 'done' })).toEqual([{ id: 'a', state: 'done' }, { id: 'b', state: 'running' }])
  // WHY: a SvelteMap notifies on `set`, so the held list must not change in place.
  expect(list[0]?.state).toBe('running')
})

test('a new record goes at the end, or first in a list kept newest first', () => {
  const list = [{ id: 'b' }, { id: 'a' }]
  expect(upsertById(list, { id: 'c' }).map((record) => record.id)).toEqual(['b', 'a', 'c'])
  expect(upsertById(list, { id: 'c' }, 'start').map((record) => record.id)).toEqual(['c', 'b', 'a'])
})
