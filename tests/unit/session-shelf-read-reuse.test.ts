import { expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { SessionStatesStore } from '@solus/workspace-ui/contexts/workspace/session-states.store.svelte'
import type { SessionShelfEntry } from '@solus/contracts/session-state'

test('settle and snooze use their change event read once, including before the first list load', async () => {
  const store = new SessionStatesStore()
  const events = new HostEventSubscriber()
  const calls: string[][] = []
  let entry: SessionShelfEntry | null = null
  const changed = () => events.receive({ type: 'session.stateChanged', payload: { sessionId: 'session' }, occurredAt: 1 })
  const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
    sessionShelfList: async (ids) => { calls.push(ids ?? []); return entry ? [entry] : [] },
    sessionSetSettled: async (_id, settled) => {
      entry = settled ? { sessionId: 'session', title: null, projectPath: null, settledAt: 1, settledBy: 'person', snoozedUntil: null, snoozeNote: null } : null
      changed()
    },
    sessionSnooze: async (_id, until) => {
      entry = { sessionId: 'session', title: null, projectPath: null, settledAt: null, settledBy: null, snoozedUntil: until, snoozeNote: null }
      changed()
    },
  }))
  const subscription = spyOn(serverConnections, 'eventsFor').mockReturnValue(events)
  try {
    await store.setSettled('host', 'session', true)
    expect(calls).toEqual([['session']])
    expect(store.stateFor('session')?.settledAt).toBe(1)
    await store.setSettled('host', 'session', false)
    expect(calls).toHaveLength(2)
    expect(store.stateFor('session')).toBeNull()
    await store.snooze('host', 'session', 100)
    expect(calls).toHaveLength(3)
    expect(store.stateFor('session')?.snoozedUntil).toBe(100)
  } finally { api.mockRestore(); subscription.mockRestore() }
})
