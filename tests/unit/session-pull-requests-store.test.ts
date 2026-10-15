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
