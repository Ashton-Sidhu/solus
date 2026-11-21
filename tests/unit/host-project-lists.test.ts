import { describe, expect, mock, test } from 'bun:test'
import type { IntegrationResourceLists } from '@solus/contracts/integration-types'
import type { HostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostListsSource } from '@solus/client-core/host-project-lists'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const saved = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
    clear: () => saved.clear(),
    key: (index: number) => [...saved.keys()][index] ?? null,
    get length() { return saved.size },
  } satisfies Storage,
})

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { HostProjectLists } = await import('@solus/client-core/host-project-lists')
const { hostCatalog } = await import('@solus/client-core/host-catalog')
const { pairPageHosts } = await import('./helpers/page-host-catalog')

/**
 * The MCP prompt and resource lists of each host and project
 * (docs/plans/mcp-first-class.md §10, §11.4). The menus read them on each
 * keystroke, so a kept list must be there at once, follow the host, and never
 * show the lists of a host that is gone.
 */

const EMPTY: IntegrationResourceLists = { resources: [], templates: [] }

/** The desktop and web source: the host's connection, its readiness, and the host catalog. */
const desktopSource: HostListsSource = {
  connection: (serverId) => ({ api: connections.apiFor(serverId), events: connections.eventsFor(serverId) }),
  watchReconnects: (serverId, reconnected) => connections.onReadinessChange((hostId, readiness) => {
    if (hostId === serverId && readiness === 'ready') reconnected()
  }),
  onForgotten: (forgotten) => hostCatalog.onForgotten((host) => forgotten(host.id)),
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function resource(name: string): IntegrationResourceLists {
  return { resources: [{ integrationId: 'docs', uri: `docs://${name}`, name }], templates: [] }
}

function hostWithLists(serverId: string, answers: Array<IntegrationResourceLists | Error | Promise<IntegrationResourceLists>>, source = desktopSource) {
  const reads: Array<string | undefined> = []
  connections.registerHost(serverId, {
    integrationResourceList: async (request: { projectPath?: string }) => {
      reads.push(request.projectPath)
      const answer = answers.shift() ?? EMPTY
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  const lists = new HostProjectLists<IntegrationResourceLists>({
    read: (api, projectPath) => api.integrationResourceList(projectPath ? { projectPath } : {}),
    empty: EMPTY,
    rereadOn: ['integration.changed'],
    source,
    map: () => new Map(),
  })
  return { lists, reads }
}

const names = (lists: IntegrationResourceLists) => lists.resources.map((entry) => entry.name)

describe('host project lists', () => {
  test('a list is read once and kept; asking again reads nothing and allocates nothing', async () => {
    const { lists, reads } = hostWithLists('once-host', [resource('a')])
    lists.ensure('once-host', '/repo')
    lists.ensure('once-host', '/repo')
    await flush()
    lists.ensure('once-host', '/repo')
    expect(reads).toEqual(['/repo'])
    // WHY: autocomplete reads the list on each keystroke; the same list must come back, not a copy.
    expect(lists.listFor('once-host', '/repo')).toBe(lists.listFor('once-host', '/repo'))
    expect(names(lists.listFor('once-host', '/repo'))).toEqual(['a'])
    expect(lists.listFor('once-host', '/other')).toBe(EMPTY)
  })

  test('a host event and a reconnect read the kept lists again; the old list shows until the new one lands', async () => {
    const { lists, reads } = hostWithLists('follow-host', [resource('a'), resource('b'), resource('c')])
    lists.ensure('follow-host', '/repo')
    await flush()
    connections.emit('follow-host', 'integration.changed', { integrationId: 'docs', change: 'updated' })
    expect(names(lists.listFor('follow-host', '/repo'))).toEqual(['a'])
    await flush()
    expect(names(lists.listFor('follow-host', '/repo'))).toEqual(['b'])
    // WHY: events sent while the host was away are lost; a reconnect must read the lists again.
    connections.emitReadiness('follow-host', 'unreachable')
    connections.emitReadiness('follow-host', 'ready')
    await flush()
    expect(reads).toHaveLength(3)
    expect(names(lists.listFor('follow-host', '/repo'))).toEqual(['c'])
  })

  test('a failed first read is read again on the next ask; a failed refresh keeps the list', async () => {
    const { lists, reads } = hostWithLists('error-host', [new Error('older host'), resource('a'), new Error('timeout')])
    lists.ensure('error-host', undefined)
    await flush()
    expect(lists.listFor('error-host', undefined)).toBe(EMPTY)
    lists.ensure('error-host', undefined)
    await flush()
    expect(names(lists.listFor('error-host', undefined))).toEqual(['a'])
    lists.reload('error-host')
    await flush()
    expect(reads).toEqual([undefined, undefined, undefined])
    expect(names(lists.listFor('error-host', undefined))).toEqual(['a'])
  })

  test('an older answer does not replace a newer one', async () => {
    let answerFirst: (lists: IntegrationResourceLists) => void = () => {}
    const first = new Promise<IntegrationResourceLists>((resolve) => { answerFirst = resolve })
    const { lists } = hostWithLists('race-host', [first, resource('new')])
    lists.ensure('race-host', '/repo')
    lists.reload('race-host')
    await flush()
    answerFirst(resource('old'))
    await flush()
    expect(names(lists.listFor('race-host', '/repo'))).toEqual(['new'])
  })

  test('a removed host takes its lists and its subscriptions with it', async () => {
    await pairPageHosts([{ id: 'gone-host', label: 'gone', routes: [], sessionToken: 't', installationId: 'gone-host', lastConnected: 1 }])
    const { lists, reads } = hostWithLists('gone-host', [resource('a'), resource('b')])
    lists.ensure('gone-host', '/repo')
    await flush()
    await hostCatalog.forget('gone-host')
    // WHY: a forgotten host's resources must not stay in the `@` menu.
    expect(lists.listFor('gone-host', '/repo')).toBe(EMPTY)
    connections.emit('gone-host', 'integration.changed', { integrationId: 'docs', change: 'updated' })
    connections.emitReadiness('gone-host', 'ready')
    await flush()
    expect(reads).toEqual(['/repo'])
  })

  test('a host with no connection waits, and its reconnect reads the list and follows the new connection', async () => {
    // WHY: mobile has a connection only while the host is ready, and a new connection has new events.
    let current: { api: HostApi; events: HostEventSubscriber } | null = null
    let reconnected = () => {}
    const source: HostListsSource = {
      connection: () => current,
      watchReconnects: (_serverId, listener) => { reconnected = listener; return () => {} },
      onForgotten: () => () => {},
    }
    const { lists, reads } = hostWithLists('phone-host', [resource('a'), resource('b')], source)
    lists.ensure('phone-host', '/repo')
    await flush()
    expect(reads).toEqual([])
    expect(lists.keptFor('phone-host', '/repo')?.status).toBe('loading')
    const events = new HostEventSubscriber()
    current = { api: connections.apiFor('phone-host'), events }
    reconnected()
    await flush()
    expect(names(lists.listFor('phone-host', '/repo'))).toEqual(['a'])
    events.receive({ type: 'integration.changed', payload: { integrationId: 'docs', change: 'updated' }, occurredAt: Date.now() })
    await flush()
    expect(names(lists.listFor('phone-host', '/repo'))).toEqual(['b'])
  })

  test('a failed first read keeps its reason for the sheet', async () => {
    const { lists } = hostWithLists('reason-host', [new Error('older host')])
    lists.ensure('reason-host', '/repo')
    await flush()
    expect(lists.keptFor('reason-host', '/repo')).toEqual({ status: 'error', value: EMPTY, error: 'older host' })
  })
})
