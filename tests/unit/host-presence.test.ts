import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HostGoneError } from '@solus/client-core/rpc-error'
import { serverConnections, ServerConnections } from '@solus/client-core/server-connections'
import { hosts } from '@solus/workspace-ui/contexts/hosts/hosts.svelte'

// docs/plans/workspace-and-machines.md §6. WHY: a deleted managed host stayed
// named in a kept project list, and a project icon asked `apiFor` for it. The
// registry threw `Unknown Solus server` inside an effect. A host this client does
// not know must be a state readers can see, never a throw they must guard.

const laptop = { id: 'laptop', label: 'Laptop', routes: [{ kind: 'lan', url: 'https://laptop.test', source: 'pairing', seenAt: 1 }], sessionToken: 't', installationId: 'laptop', lastConnected: 1 }

let savedHosts: object[] = []
const previousLocalStorage = globalThis.localStorage

beforeEach(() => {
  savedHosts = []
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => key === 'solus.servers' ? JSON.stringify(savedHosts) : null,
      setItem: () => {},
      removeItem: () => {},
    },
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousLocalStorage })
})

describe('a host this client does not know', () => {
  test('is gone, and a saved or registered host is present', () => {
    savedHosts = [laptop]
    const connections = new ServerConnections()
    connections.registerTarget({ id: 'local', label: 'This computer', url: 'http://127.0.0.1:1', sessionToken: '', local: true })

    expect(connections.presenceOf('laptop')).toBe('present')
    expect(connections.presenceOf('local')).toBe('present')
    expect(connections.presenceOf('managed:gone')).toBe('gone')
  })

  test('answers every reader without a throw, and each call fails as a gone host', async () => {
    const connections = new ServerConnections()

    expect(() => connections.eventsFor('managed:gone')).not.toThrow()
    expect(connections.httpOriginFor('managed:gone')).toBe('')
    const call = connections.apiFor('managed:gone').listProjects()
    await expect(call).rejects.toBeInstanceOf(HostGoneError)
    expect(connections.connectionFor('managed:gone')?.presence).toBe('gone')
    // Reads that fan out across hosts never reach it.
    expect(connections.connectedServerIds()).not.toContain('managed:gone')
  })

  test('gets a real connection once it is listed, and a gone one again when it is removed', () => {
    const connections = new ServerConnections()
    const gone = connections.ensure('laptop')
    expect(gone.presence).toBe('gone')

    savedHosts = [laptop]
    expect(connections.presenceOf('laptop')).toBe('present')
    const live = connections.ensure('laptop')
    expect(live.presence).toBe('present')
    expect(live).not.toBe(gone)

    // Deleted again in the same frame, so the real connection never dials.
    savedHosts = []
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
