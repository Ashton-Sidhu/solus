import { describe, expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import type { IntegrationDiscoveredEvent, FoundServerList, IntegrationFoundListRequest } from '@solus/contracts/integration-types'
import { discoverMcpServers, onDiscoveredHost, remoteDiscoveryReach, type DiscoveryTarget, type DiscoveryReach } from '@solus/server/integrations/discovery'

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

/** A host that answers `integrationFoundList` with `answer`, and records each request. */
function target(hostId: string, answer: () => Promise<FoundServerList>, requests: IntegrationFoundListRequest[] = []): DiscoveryTarget {
  const api = {
    integrationFoundList: (request: IntegrationFoundListRequest) => {
      requests.push(request)
      return answer()
    },
  } as Pick<HostApi, 'integrationFoundList'> as HostApi
  return { hostId, label: `${hostId} label`, call: (_what, request) => request(api) }
}

const reachOf = (targets: DiscoveryTarget[]): DiscoveryReach => ({
  targets: async () => targets,
  target: async (hostId) => targets.find((candidate) => candidate.hostId === hostId) ?? null,
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('one discovery of the MCP servers of every host', () => {
  test("this host's list goes out before the list of hosts is known", async () => {
    const events: IntegrationDiscoveredEvent[] = []
    const hostList = gate<DiscoveryTarget[]>()
    const discovery = discoverMcpServers({
      discoveryId: 'discovery-1', selfLabel: 'Laptop', refresh: false,
      local: async () => EMPTY,
      reach: { targets: () => hostList.promise, target: async () => null },
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
      reach: reachOf([target('slow-box', () => slow.promise), target('fast-box', async () => EMPTY, fastRequests)]),
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
      reach: reachOf([
        target('old-box', async () => { throw new Error('SolusServer: no handler for "integrationFoundList"') }),
        target('away-box', async () => { throw new Error('away-box did not answer its MCP config files within 30 s.') }),
      ]),
      publish: (event) => events.push(event),
    })
    await flush()
    const byHost = new Map(events.map((event) => [event.host.hostId, event.result]))
    expect(byHost.get('old-box')).toEqual({ kind: 'unsupported' })
    expect(byHost.get('away-box')).toEqual({ kind: 'failed', message: 'away-box did not answer its MCP config files within 30 s.' })
    expect(byHost.get(null)?.kind).toBe('loaded')
  })

  test('a caller this host reaches no other host for gets this host only', async () => {
    const remoteHosts = { list: async () => { throw new Error('must not list') }, find: async () => { throw new Error('must not find') }, connect: () => { throw new Error('must not dial') } }
    const reach = remoteDiscoveryReach(remoteHosts, null)
    expect(await reach.targets()).toEqual([])
    await expect(onDiscoveredHost(reach, 'build-box', 'the add', async () => 'done')).rejects.toThrow('You do not reach that host from here any more')
  })
})
