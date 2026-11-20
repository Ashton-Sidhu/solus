import { expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { SessionPullRequestsStore } from '@solus/workspace-ui/contexts/prs/session-pull-requests.store.svelte'

// A host announces the pull request change of every session it keeps, and
// most of them are not on this client's screen. Reading each one back cost a
// request per announcement for links nothing shows.

const link = (sessionId: string): SessionPullRequestLink => ({
  sessionId, repository: 'github.com/acme/web', number: 1, url: 'https://github.com/acme/web/pull/1', title: 'One', source: 'manual', linkedAt: 1,
})

function fakeHome() {
  const events = new HostEventSubscriber()
  const reads: string[] = []
  const api = asHostApi({
    sessionPullRequests: async (sessionId: string) => { reads.push(sessionId); return [link(sessionId)] },
  })
  const apiFor = spyOn(serverConnections, 'apiFor').mockImplementation(() => api)
  const eventsFor = spyOn(serverConnections, 'eventsFor').mockImplementation(() => events)
  const announce = (sessionId: string) =>
    events.receive({ type: 'session.pullRequestsChanged', payload: { sessionId }, occurredAt: 1 })
  return { reads, announce, restore: () => { apiFor.mockRestore(); eventsFor.mockRestore() } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('reads again only the sessions this client shows', async () => {
  const { reads, announce, restore } = fakeHome()
  try {
    const store = new SessionPullRequestsStore()
    store.adopt('host', [{ sessionId: 'listed', pullRequests: [] }])

    announce('listed')
    announce('elsewhere')
    await settle()
    expect(reads).toEqual(['listed'])
    expect(store.linksFor('listed')).toEqual([link('listed')])
  } finally { restore() }
})

test('a session a surface asked for before any list named it is read again', async () => {
  // WHY: a new session's tab shows its pull requests before the next list
  // read names the session.
  const { reads, announce, restore } = fakeHome()
  try {
    const store = new SessionPullRequestsStore()
    store.adopt('host', [])
    expect(store.linksFor('new-tab')).toEqual([])

    announce('new-tab')
    await settle()
    expect(reads).toEqual(['new-tab'])
    expect(store.linksFor('new-tab')).toEqual([link('new-tab')])
  } finally { restore() }
})

test('stopping a watch asks the host that runs the session, then reads the links from their home', async () => {
  // WHY: a watch is a record of the host that runs the session, while an
  // organization session keeps its links at another home. Asking the home
  // would refuse the stop; not reading again would leave "Stop watching" on.
  const watches: { serverId: string; sessionId: string; watching: boolean }[] = []
  const reads: string[] = []
  let watched = true
  // One api per host, as the connections keep them: the store drops a read
  // whose host connection was replaced.
  const apis = new Map<string, ReturnType<typeof asHostApi>>()
  const apiOf = (serverId: string) => asHostApi({
    sessionPullRequestWatch: async (sessionId: string, _repository: string, _number: number, watching: boolean) => {
      watches.push({ serverId, sessionId, watching })
      watched = watching
      return 'stopped' as const
    },
    sessionPullRequests: async (sessionId: string) => {
      reads.push(serverId)
      return [{ ...link(sessionId), ...(watched ? { watch: { startedAt: 1 } } : {}) }]
    },
  })
  const apiFor = spyOn(serverConnections, 'apiFor').mockImplementation((serverId: string) => {
    if (!apis.has(serverId)) apis.set(serverId, apiOf(serverId))
    return apis.get(serverId)!
  })
  const eventsFor = spyOn(serverConnections, 'eventsFor').mockImplementation(() => new HostEventSubscriber())
  try {
    const store = new SessionPullRequestsStore()
    store.adopt('organization', [{ sessionId: 's', pullRequests: [{ ...link('s'), watch: { startedAt: 1 } }] }])
    expect(store.linksFor('s')[0]!.watch).toBeDefined()

    expect(await store.setWatch('machine', link('s'), false)).toBe('stopped')
    expect(watches).toEqual([{ serverId: 'machine', sessionId: 's', watching: false }])
    expect(reads).toEqual(['organization'])
    expect(store.linksFor('s')[0]!.watch).toBeUndefined()
  } finally { apiFor.mockRestore(); eventsFor.mockRestore() }
})
