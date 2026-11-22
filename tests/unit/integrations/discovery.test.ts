import { describe, expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { IntegrationDiscoveredEvent, FoundServerList, IntegrationFoundListRequest } from '@solus/contracts/integration-types'
import { discoverMcpServers } from '@solus/server/integrations/discovery'
import type { HostTarget, ReachRequest, RemoteHost } from '@solus/server/execution/orchestration/remote-hosts'

// docs/plans/mcp-first-class.md §8.9: the page's host asks every host it
// reaches for the person, and each host's list goes to the client as soon as
// that host answers. A slow host holds back only its own list, and the
// project, a path on the page's host, never goes to another host.

const EMPTY: FoundServerList = { servers: [], files: [] }

/** A gate a test opens when it wants a host to answer. */
function gate<T>() {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => { open = resolve })
  return { promise, open }
}

/** Another host as `RemoteHosts` lists it and connects to it: it answers `integrationFoundList` with `answer` and records each request. */
interface FakeHost { target: HostTarget; remote: RemoteHost }
function host(hostId: string, answer: () => Promise<FoundServerList>, requests: IntegrationFoundListRequest[] = []): FakeHost {
  const api = {
    integrationFoundList: (request: IntegrationFoundListRequest) => {
      requests.push(request)
      return answer()
    },
  } as Pick<HostApi, 'integrationFoundList'> as HostApi
  const label = `${hostId} label`
  return {
    target: { hostId, installationId: hostId, label, routes: [], source: 'paired', connectionKey: `paired:${hostId}`, credential: async () => null },
    remote: { hostId, installationId: hostId, label, api, events: new HostEventSubscriber(), onReconnected: () => () => {}, call: (_what, request) => request() },
  }
}

const OWNER: ReachRequest = { account: null, isOwner: true }
/** `RemoteHosts` with these hosts: the list as `list` answers it, and each connection. */
function hostsOf(hosts: FakeHost[], list: () => Promise<HostTarget[]> = async () => hosts.map((known) => known.target)) {
  return {
    list,
    connect: (target: HostTarget) => hosts.find((known) => known.target.hostId === target.hostId)!.remote,
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('one discovery of the MCP servers of every host', () => {
  test("this host's list goes out before the list of hosts is known", async () => {
    const events: IntegrationDiscoveredEvent[] = []
    const hostList = gate<HostTarget[]>()
    const discovery = discoverMcpServers({
      discoveryId: 'discovery-1', selfLabel: 'Laptop', refresh: false,
      local: async () => EMPTY,
      hosts: hostsOf([], () => hostList.promise), reach: OWNER,
      publish: (event) => events.push(event),
    })
    await flush()
    expect(events.map((event) => event.host.hostId)).toEqual([null])

    hostList.open([])
    expect((await discovery).hosts).toEqual([{ hostId: null, label: 'Laptop' }])
  })

  test('each host answers when it is ready; a slow host holds back only its own list', async () => {
    const events: IntegrationDiscoveredEvent[] = []
    const slow = gate<FoundServerList>()
    const fastRequests: IntegrationFoundListRequest[] = []
    const answer = await discoverMcpServers({
      discoveryId: 'discovery-2', selfLabel: 'Laptop', refresh: true,
      local: async () => EMPTY,
      hosts: hostsOf([host('slow-box', () => slow.promise), host('fast-box', async () => EMPTY, fastRequests)]), reach: OWNER,
      publish: (event) => events.push(event),
    })
    expect(answer.hosts.map((host) => host.hostId)).toEqual([null, 'slow-box', 'fast-box'])
    await flush()
    expect(events.map((event) => event.host.hostId)).toEqual([null, 'fast-box'])

    slow.open(EMPTY)
    await flush()
    expect(events.map((event) => event.host.hostId)).toEqual([null, 'fast-box', 'slow-box'])
    expect(events.every((event) => event.discoveryId === 'discovery-2')).toBe(true)
    // Another host reads its user files only, again when the person asked for a refresh.
    expect(fastRequests).toEqual([{ refresh: true }])
  })

  test('a host that fails or is older says so in its own list', async () => {
    const events: IntegrationDiscoveredEvent[] = []
    await discoverMcpServers({
      discoveryId: 'discovery-3', selfLabel: 'Laptop', refresh: false,
      local: async () => EMPTY,
      hosts: hostsOf([
        host('old-box', async () => { throw new Error('SolusServer: no handler for "integrationFoundList"') }),
        host('away-box', async () => { throw new Error('away-box did not answer its MCP config files within 30 s.') }),
      ]),
      reach: OWNER,
      publish: (event) => events.push(event),
    })
    await flush()
    const byHost = new Map(events.map((event) => [event.host.hostId, event.result]))
    expect(byHost.get('old-box')).toEqual({ kind: 'unsupported' })
    expect(byHost.get('away-box')).toEqual({ kind: 'failed', message: 'away-box did not answer its MCP config files within 30 s.' })
    expect(byHost.get(null)?.kind).toBe('loaded')
  })

  test('a caller this host reaches no other host for gets this host only', async () => {
    const events: IntegrationDiscoveredEvent[] = []
    const answer = await discoverMcpServers({
      discoveryId: 'discovery-4', selfLabel: 'Laptop', refresh: false,
      local: async () => EMPTY,
      hosts: { list: async () => { throw new Error('must not list') }, connect: () => { throw new Error('must not dial') } },
      reach: null,
      publish: (event) => events.push(event),
    })
    expect(answer.hosts).toEqual([{ hostId: null, label: 'Laptop' }])
  })

  test('a host that cannot be dialed says why in its own list', async () => {
    const events: IntegrationDiscoveredEvent[] = []
    const stopped = host('stopped-box', async () => EMPTY)
    await discoverMcpServers({
      discoveryId: 'discovery-5', selfLabel: 'Laptop', refresh: false,
      local: async () => EMPTY,
      hosts: { list: async () => [stopped.target], connect: () => ({ error: 'stopped-box is stopped. Start it first, then try again.' }) },
      reach: OWNER,
      publish: (event) => events.push(event),
    })
    await flush()
    expect(events.find((event) => event.host.hostId === 'stopped-box')?.result).toEqual({ kind: 'failed', message: 'stopped-box is stopped. Start it first, then try again.' })
  })
})
