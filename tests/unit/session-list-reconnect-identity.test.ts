import { expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { EMPTY_SESSION_VIEW } from '@solus/contracts/session-state'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { SessionRecord } from '@solus/contracts/types'
import { SessionListStore } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'
import { sessionPullRequestsStore } from '@solus/workspace-ui/contexts/prs/session-pull-requests.store.svelte'

// Each reconnect reads every home's session list again (T3 Code #20855). A
// home that answers what the client holds must not replace the held entries:
// each sidebar row and linked pull request reader compares by identity and
// draws again on a new object. A row that did change must get its new value.

const link = (sessionId: string): SessionPullRequestLink =>
  ({ sessionId, repository: 'github.com/acme/web', number: 1, url: 'https://github.com/acme/web/pull/1', title: 'One', source: 'manual', linkedAt: 1 })
const record = (sessionId: string, title: string) => ({
  sessionId, title, customTitle: null, slug: null, projectRoot: '/repo', projectPath: '-repo', createdAt: 1, organizationId: 'local', listed: true,
  state: { settledAt: 7, settledBy: 'person' },
  view: { ...EMPTY_SESSION_VIEW, snoozedUntil: 100 },
  pullRequests: [link(sessionId)],
}) as SessionRecord

test('an equal list keeps every held entry, and a changed row gets its new value', async () => {
  const titles: Record<string, string> = { same: 'Same', changed: 'Before' }
  // The host sends new objects on each read, as a reconnect does.
  const api = asHostApi({
    sessionRecordList: async () => ({ records: Object.entries(titles).map(([sessionId, title]) => record(sessionId, title)), indexing: false }),
  })
  const events = new HostEventSubscriber()
  const apiFor = spyOn(serverConnections, 'apiFor').mockImplementation(() => api)
  const eventsFor = spyOn(serverConnections, 'eventsFor').mockImplementation(() => events)
  const store = new SessionListStore({ connectedRunnerFor: () => null, connectedServerIds: () => ['host'] })
  try {
    await store.load()
    const listed = store.listed('same')
    const state = store['statesBySession'].get('same')
    const view = store['viewsBySession'].get('same')
    const links = sessionPullRequestsStore.linksFor('same')
    const changedBefore = store.listed('changed')

    titles.changed = 'After'
    await store.load()

    expect(store.listed('same')).toBe(listed!)
    expect(store['statesBySession'].get('same')).toBe(state!)
    expect(store['viewsBySession'].get('same')).toBe(view!)
    expect(sessionPullRequestsStore.linksFor('same')).toBe(links)
    expect(store.listed('changed')).not.toBe(changedBefore!)
    expect(store.listed('changed')?.title).toBe('After')
  } finally {
    apiFor.mockRestore()
    eventsFor.mockRestore()
  }
})
