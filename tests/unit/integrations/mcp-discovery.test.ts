import { afterAll, describe, expect, test } from 'bun:test'
import type { IntegrationDiscoveredEvent, IntegrationDiscovery, FoundServer, IntegrationFoundAddRequest, IntegrationDiscoverRequest } from '@solus/contracts/integration-types'
import { singleHostServerConnections } from '../helpers/server-connections-mock'
import { SvelteRunes } from '../helpers/svelte-runes'

const connections = singleHostServerConnections()
// The lists hold runes: they run compiled on Svelte's client runtime, against these connections.
const runes = new SvelteRunes()
const scope = globalThis as unknown as { foundConnections?: typeof connections }
scope.foundConnections = connections
afterAll(() => { runes.dispose(); delete scope.foundConnections })
const foundModule = runes.source('mcp-found', 'packages/workspace-ui/src/contexts/mcp/mcp-found.svelte.ts', {
  '@solus/client-core/server-connections': runes.module('found-connections', 'export const serverConnections = globalThis.foundConnections'),
  '@solus/client-core/random-id': SvelteRunes.file('packages/client-core/src/random-id.ts'),
  'svelte/reactivity': SvelteRunes.file('node_modules/svelte/src/reactivity/index-client.js'),
  './integration-sign-ins.svelte': SvelteRunes.file('packages/workspace-ui/src/contexts/mcp/integration-sign-ins.svelte.ts'),
})
const { McpDiscovery } = await import(foundModule) as typeof import('@solus/workspace-ui/contexts/mcp/mcp-found.svelte')

// docs/plans/mcp-first-class.md §8.9: the page's host asks every host it
// reaches for the person, and each host's group fills as its answer arrives.
// The page's project is a path on the page's host, so an action on another
// host never carries it.

function server(name: string): FoundServer {
  return {
    foundId: `found-${name}`, fingerprint: `print-${name}`, name, state: 'new',
    foundIn: [{ kind: 'file', file: 'claude-json', scope: 'user', path: '~/.claude.json', filePath: '/home/me/.claude.json', name }],
    transport: { kind: 'stdio', command: 'npx', args: [name], envNames: [] },
    projectOnly: true, valuesInFile: [],
  }
}

/** The page's host: it holds each discovery's answer until the test gives it, and records each request. */
function pageHost() {
  const discoveries: IntegrationDiscoverRequest[] = []
  const adds: IntegrationFoundAddRequest[] = []
  const answers: Array<(answer: IntegrationDiscovery) => void> = []
  connections.reset()
  connections.registerHost('laptop', {
    integrationDiscover: (request: IntegrationDiscoverRequest) => {
      discoveries.push(request)
      return new Promise<IntegrationDiscovery>((resolve) => answers.push(resolve))
    },
    integrationFoundAdd: async (request: IntegrationFoundAddRequest) => {
      adds.push(request)
      return { kind: 'found-changed' }
    },
  })
  const discovered = (payload: IntegrationDiscoveredEvent) => connections.eventsFor('laptop').receive({ type: 'integration.discovered', payload, occurredAt: Date.now() })
  return { discoveries, adds, answers, discovered }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const buildBox = { hostId: 'build-box', label: 'Build box' }

describe('one discovery of the MCP servers of every host', () => {
  test("each host's group fills as its answer arrives, before the discovery answers", async () => {
    const host = pageHost()
    const discovery = new McpDiscovery('laptop', '/work/app')
    await flush()
    const discoveryId = host.discoveries[0]!.discoveryId
    expect(host.discoveries[0]!.projectPath).toBe('/work/app')

    host.discovered({ discoveryId, host: buildBox, result: { kind: 'loaded', list: { servers: [server('postgres')], files: [] } } })
    expect(discovery.hosts.map((group) => group.hostId)).toEqual([null, 'build-box'])
    expect(discovery.hosts[1]!.notAdded.map((found) => found.name)).toEqual(['postgres'])
    // This host has not answered yet: its group waits alone.
    expect(discovery.self.loading).toBe(true)

    host.discovered({ discoveryId, host: { hostId: null, label: 'Laptop' }, result: { kind: 'loaded', list: { servers: [server('github')], files: [] } } })
    expect(discovery.self.notAdded.map((found) => found.name)).toEqual(['github'])
    host.answers[0]!({ hosts: [{ hostId: null, label: 'Laptop' }, buildBox] })
    await flush()
    expect(discovery.refreshing).toBe(false)
    discovery.dispose()
  })

  test('an answer of an older discovery changes nothing', async () => {
    const host = pageHost()
    const discovery = new McpDiscovery('laptop', null)
    await flush()
    const oldDiscoveryId = host.discoveries[0]!.discoveryId
    void discovery.discover(true)
    await flush()

    host.discovered({ discoveryId: oldDiscoveryId, host: buildBox, result: { kind: 'loaded', list: { servers: [server('postgres')], files: [] } } })
    expect(discovery.hosts.map((group) => group.hostId)).toEqual([null])
    discovery.dispose()
  })

  test("an add on another host names that host and not this host's project", async () => {
    const host = pageHost()
    const discovery = new McpDiscovery('laptop', '/work/app')
    await flush()
    host.discovered({ discoveryId: host.discoveries[0]!.discoveryId, host: buildBox, result: { kind: 'loaded', list: { servers: [server('postgres')], files: [] } } })
    const group = discovery.hosts[1]!

    await group.add(server('postgres'), true)
    expect(host.adds).toEqual([{ foundId: 'found-postgres', fingerprint: 'print-postgres', hostId: 'build-box', projectPath: undefined, useFileValues: true }])
    // The other host's lists differ now: every host reads again.
    expect(host.discoveries.length).toBe(2)

    await discovery.self.add(server('github'), false)
    expect(host.adds[1]).toEqual({ foundId: 'found-github', fingerprint: 'print-github', hostId: undefined, projectPath: '/work/app', useFileValues: undefined })
    discovery.dispose()
  })
})
