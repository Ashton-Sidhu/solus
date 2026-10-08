import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostFacts } from '@solus/client-core/host-facts'
import { serverConnections, type ManagedConnection } from '@solus/client-core/server-connections'
import { hosts } from '@solus/workspace-ui/contexts/hosts/hosts.svelte'

// Which planes a host serves gates where work and records are offered
// (docs/plans/cloud-service-model.md). docs/plans/host-model.md moved the
// answer onto each host's facts.

afterEach(() => mock.restore())

function connectedWith(roles: string[]): ManagedConnection {
  const facts = new HostFacts('remote', {
    api: asHostApi({ connectionsGetServerInfo: async () => ({ roles }) }),
    events: new HostEventSubscriber(),
  })
  return { serverId: 'remote', facts } as unknown as ManagedConnection
}

describe('host roles', () => {
  test('asking which planes a host serves never opens a connection to it', () => {
    const factsFor = spyOn(serverConnections, 'factsFor')
    spyOn(serverConnections, 'connectionFor').mockImplementation(() => undefined)
    spyOn(serverConnections, 'isKnownServer').mockImplementation(() => true)
    expect(hosts.rolesFor('saved-laptop')).toEqual(['collaboration', 'execution'])
    expect(factsFor).not.toHaveBeenCalled()
  })

  test('a host this client does not know serves nothing', () => {
    spyOn(serverConnections, 'connectionFor').mockImplementation(() => undefined)
    spyOn(serverConnections, 'isKnownServer').mockImplementation(() => false)
    expect(hosts.hasExecution('deleted-machine')).toBe(false)
    expect(hosts.hasCollaboration('deleted-machine')).toBe(false)
  })

  test('a connected host is assumed to serve both until it answers, then serves what it says', async () => {
    const connection = connectedWith(['collaboration'])
    spyOn(serverConnections, 'connectionFor').mockImplementation(() => connection)
    spyOn(serverConnections, 'isKnownServer').mockImplementation(() => true)
    expect(hosts.rolesFor('remote')).toEqual(['collaboration', 'execution'])
    await connection.facts.when('serverInfo')
    expect(hosts.rolesFor('remote')).toEqual(['collaboration'])
  })
})
