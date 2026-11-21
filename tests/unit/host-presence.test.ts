import { beforeEach, describe, expect, test } from 'bun:test'
import type { HostCatalog } from '@solus/client-core/host-catalog'
import { catalogOf, fakeList, listingFor, memoryCredentials } from './helpers/host-catalog-world'
import { HostGoneError } from '@solus/client-core/rpc-error'
import { serverConnections, ServerConnections } from '@solus/client-core/server-connections'
import { hosts } from '@solus/workspace-ui/contexts/hosts/hosts.svelte'

// docs/plans/workspace-and-machines.md §6. WHY: a deleted managed host stayed
// named in a kept project list, and a project icon asked `apiFor` for it. The
// registry threw `Unknown Solus server` inside an effect. A host this client does
// not know must be a state readers can see, never a throw they must guard.

const laptop = listingFor('laptop', { label: 'Laptop', routes: [{ kind: 'lan', url: 'https://laptop.test', source: 'pairing', seenAt: 1 }] })

let catalog: HostCatalog
let list: ReturnType<typeof fakeList>

beforeEach(async () => {
  catalog = catalogOf({ credentials: memoryCredentials([]) })
  list = fakeList([], 'test')
  await catalog.useListSource(list.source)
})

/** The person's list names the laptop, or no longer does, and the catalog reads it. */
async function listLaptop(isListed: boolean): Promise<void> {
  list.state.listings = new Map(isListed ? [['laptop', laptop]] : [])
  await catalog.refreshList()
}

describe('a host this client does not know', () => {
  test('is gone, and a listed or registered host is present', async () => {
    await listLaptop(true)
    const connections = new ServerConnections(catalog)
    connections.registerTarget({ id: 'local', label: 'This computer', url: 'http://127.0.0.1:1', sessionToken: '', local: true })

    expect(connections.presenceOf('laptop')).toBe('present')
    expect(connections.presenceOf('local')).toBe('present')
    expect(connections.presenceOf('managed:gone')).toBe('gone')
  })

  test('answers every reader without a throw, and each call fails as a gone host', async () => {
    const connections = new ServerConnections(catalog)

    expect(() => connections.eventsFor('managed:gone')).not.toThrow()
    expect(connections.httpOriginFor('managed:gone')).toBe('')
    const call = connections.apiFor('managed:gone').listProjects()
    await expect(call).rejects.toBeInstanceOf(HostGoneError)
    expect(connections.connectionFor('managed:gone')?.presence).toBe('gone')
    // Reads that fan out across hosts never reach it.
    expect(connections.connectedServerIds()).not.toContain('managed:gone')
  })

  test('gets a real connection once it is listed, and a gone one again when it is removed', async () => {
    const connections = new ServerConnections(catalog)
    const gone = connections.ensure('laptop')
    expect(gone.presence).toBe('gone')

    await listLaptop(true)
    expect(connections.presenceOf('laptop')).toBe('present')
    const live = connections.ensure('laptop')
    expect(live.presence).toBe('present')
    expect(live).not.toBe(gone)

    // Deleted again in the same frame, so the real connection never dials.
    await listLaptop(false)
    connections.release('laptop')
    expect(connections.connectionFor('laptop')?.presence).toBe('gone')
    expect(connections.presenceOf('laptop')).toBe('gone')
  })
})

describe('the Host of a gone machine', () => {
  test('says it is gone, serves no plane, and allows no action', () => {
    const host = hosts.get('managed:gone-host')

    expect(host.presence).toBe('gone')
    expect(host.roles).toEqual([])
    expect(host.me.may('host.git.write')).toBe(false)
    expect(serverConnections.presenceOf('managed:gone-host')).toBe('gone')
  })
})
