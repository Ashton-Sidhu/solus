import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function owners() {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionRecords } = await import('@solus/workspace-ui/contexts/workspace/session-records.svelte')
  const { TabRegistry } = await import('@solus/workspace-ui/contexts/workspace/tab-registry.svelte')
  const sessions = new SessionRecords()
  return { sessions, registry: new TabRegistry(sessions) }
}

function session(id: string): Session {
  return { id, run: { workingDirectory: '/repo' } as Session['run'] } as Session
}

function tab(id: string, sessionId: string): Tab {
  return { id, sessionId, hasUnread: false } as Tab
}

describe('session records own sessions; tabs only name them', () => {
  test('two tabs on one session resolve the same record', async () => {
    // WHY: a split chat is two views of one conversation. What is typed or
    // streamed in one must be what the other shows, so both resolve one object.
    const { sessions, registry } = await owners()
    sessions.byId['s1'] = session('s1')
    registry.tabs['a'] = tab('a', 's1')
    registry.tabs['b'] = tab('b', 's1')

    expect(registry.sessionFor('a')).toBe(sessions.byId['s1'])
    expect(registry.sessionFor('b')).toBe(sessions.byId['s1'])
  })

  test('removing every tab leaves the session record', async () => {
    // WHY: a conversation closed while it still runs keeps receiving events;
    // tab lifetime must not decide whether the session exists.
    const { sessions, registry } = await owners()
    sessions.byId['s1'] = session('s1')
    registry.tabs['a'] = tab('a', 's1')
    registry.tabOrder.push('a')

    delete registry.tabs['a']
    registry.pruneTabOrder()

    expect(registry.sessionFor('a')).toBeUndefined()
    expect(sessions.byId['s1']?.id).toBe('s1')
  })

  test('re-keying keeps the same object and refuses to evict another session', async () => {
    // WHY: adopting a host-assigned id must not replace the live object every
    // surface holds, and must never overwrite a session already known by that id.
    const { sessions } = await owners()
    const local = session('local')
    sessions.byId['local'] = local
    sessions.byId['taken'] = session('taken')

    expect(sessions.rekey('local', 'taken')).toBe(false)
    expect(sessions.byId['local']).toBe(local)

    expect(sessions.rekey('local', 'host-id')).toBe(true)
    expect(sessions.byId['host-id']).toBe(local)
    expect(local.id).toBe('host-id')
    expect(sessions.byId['local']).toBeUndefined()
  })
})
