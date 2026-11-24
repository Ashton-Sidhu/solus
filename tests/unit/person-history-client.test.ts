import { describe, expect, test } from 'bun:test'
import type { PersonHistoryEntry } from '@solus/contracts/person-history'
import { recentArtifactKey } from '@solus/client-core/recent-artifacts'
import {
  PersonHistory,
  appHistoryKey,
  personHistoryHomeId,
  workHistoryKey,
  type PersonHistoryChange,
  type PersonHistoryHome,
} from '@solus/client-core/person-history'

/**
 * The person's history on a client (docs/plans/person-state.md): an open shows
 * at once, reaches the home in a batch, survives a home that is away, and the
 * history follows the person to their account at sign-in.
 */

type Listener = (payload: { entries: PersonHistoryEntry[] }) => void

/** A home that keeps the later time of each key, as the server does. */
function fakeHome(serverId: string, held = new Map<string, number>()) {
  let listener: Listener | null = null
  let isAway = false
  const sent: PersonHistoryEntry[][] = []
  const home: PersonHistoryHome & { held: Map<string, number>; sent: PersonHistoryEntry[][]; emit: Listener; setAway(away: boolean): void } = {
    serverId,
    held,
    sent,
    api: {
      personHistoryRecord: async (entries) => {
        if (isAway) throw new Error('away')
        sent.push(entries)
        for (const { key, openedAt } of entries) if (openedAt > (held.get(key) ?? -1)) held.set(key, openedAt)
      },
      personHistoryList: async () => {
        if (isAway) throw new Error('away')
        return [...held].map(([key, openedAt]) => ({ key, openedAt }))
      },
    },
    events: {
      subscribe: ((_type: string, next: Listener) => {
        listener = next
        return () => { listener = null }
      }) as PersonHistoryHome['events']['subscribe'],
    },
    emit: (payload) => listener?.(payload),
    setAway: (away) => { isAway = away },
  }
  return home
}

function client() {
  const changes: PersonHistoryChange[] = []
  const history = new PersonHistory({ onChange: (change) => changes.push(change), batchDelayMs: 0 })
  return { history, changes }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('the home of a person’s history', () => {
  test('signed in it is the Solus API; signed out the device host, else the default host', () => {
    // WHY: plan 031 D7. A signed-out person's other devices all reach the device
    // host; a signed-in person's devices all reach their account.
    expect(personHistoryHomeId({ signedIn: true, solusApiId: 'workspace:org-1', deviceHostId: 'local', defaultServerId: 'local' })).toBe('workspace:org-1')
    expect(personHistoryHomeId({ signedIn: false, solusApiId: null, deviceHostId: 'local', defaultServerId: 'local' })).toBe('local')
    // A phone has no device host: the host it pairs with.
    expect(personHistoryHomeId({ signedIn: false, solusApiId: null, deviceHostId: null, defaultServerId: 'host-a' })).toBe('host-a')
    // Signed in with no organization connection, the device host still keeps it.
    expect(personHistoryHomeId({ signedIn: true, solusApiId: null, deviceHostId: 'local', defaultServerId: 'workspace:org-1' })).toBe('local')
    expect(personHistoryHomeId({ signedIn: false, solusApiId: null, deviceHostId: null, defaultServerId: 'workspace:org-1' })).toBeNull()
  })

  test('a work or an app opened from any surface is the same entry as its Threads item', () => {
    expect(workHistoryKey('w1')).toBe(recentArtifactKey({ kind: 'work', workId: 'w1', title: '', workType: 'doc', linkedAt: 0 }))
    expect(appHistoryKey('install-1', 'a1')).toBe(recentArtifactKey({ kind: 'app', hostId: 'install-1', appId: 'a1', slug: 's', title: '', linkedAt: 0 }))
  })
})

describe('the person’s history on a client', () => {
  test('an open shows at once and reaches the home in one batch', async () => {
    const home = fakeHome('local')
    const { history } = client()
    await history.useHome(home)
    history.record('work:w1', 1_000)
    history.record('app:h1:a1', 2_000)
    expect(history.openedAt('work:w1')).toBe(1_000)
    await settle()
    expect(home.sent).toEqual([[{ key: 'work:w1', openedAt: 1_000 }, { key: 'app:h1:a1', openedAt: 2_000 }]])
  })

  test('opens the home did not take go when it answers again', async () => {
    // WHY: a phone on a train still opens things. Nothing it opened is lost.
    const home = fakeHome('local')
    const { history } = client()
    await history.useHome(home)
    home.setAway(true)
    history.record('work:w1', 1_000)
    await settle()
    expect(home.held.size).toBe(0)
    home.setAway(false)
    await history.reload()
    await settle()
    expect(home.held.get('work:w1')).toBe(1_000)
  })

  test('another device’s open moves the entry; an older one does not', async () => {
    const home = fakeHome('local', new Map([['work:w1', 5_000]]))
    const { history, changes } = client()
    await history.useHome(home)
    expect(history.openedAt('work:w1')).toBe(5_000)
    home.emit({ entries: [{ key: 'work:w1', openedAt: 4_000 }] })
    expect(history.openedAt('work:w1')).toBe(5_000)
    home.emit({ entries: [{ key: 'work:w1', openedAt: 6_000 }] })
    expect(history.openedAt('work:w1')).toBe(6_000)
    expect(changes.at(-1)).toEqual(['work:w1'])
  })

  test('at sign-in the device host’s history goes into the account', async () => {
    // WHY: "local until sign-in". What the person opened while signed out is
    // still recent after they sign in, on every device of theirs.
    const device = fakeHome('local', new Map([['work:old', 1_000]]))
    const account = fakeHome('workspace:org-1', new Map([['app:h1:a1', 2_000]]))
    const { history, changes } = client()
    await history.useHome(device)
    await history.useHome(account, device.api)
    await settle()
    expect(changes).toContain('reset')
    expect(history.entries()).toEqual([{ key: 'app:h1:a1', openedAt: 2_000 }, { key: 'work:old', openedAt: 1_000 }])
    expect(account.held.get('work:old')).toBe(1_000)
  })

  test('drops a key that names no history kind', async () => {
    const home = fakeHome('local')
    const { history } = client()
    await history.useHome(home)
    history.record('pull-request:https://example.com/1', 1_000)
    await settle()
    expect(history.entries()).toEqual([])
    expect(home.sent).toEqual([])
  })
})
