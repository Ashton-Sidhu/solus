import { expect, mock, test } from 'bun:test'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
const statuses = new Map([['ready', 'connected'], ['waiting', 'connecting']])
const reads: string[] = []
let created: ((connection: { serverId: string }) => void) | undefined
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...connections,
    connectedServerIds: () => [...statuses.keys()],
    statusFor: (serverId: string) => statuses.get(serverId),
    onConnectionCreated: (listener: (connection: { serverId: string }) => void) => {
      created = listener
      return () => { created = undefined }
    },
    serverInfoFor: async (serverId: string) => {
      reads.push(serverId)
      return { roles: ['collaboration'] }
    },
  },
}))

test('role startup reads accepted connections and waits for acceptance of a new connection', async () => {
  const { hostRolesStore } = await import('@solus/workspace-ui/contexts/connections/host-roles.store.svelte')
  // Drain the queued startup load and its promise continuation, with no timers.
  for (let index = 0; index < 8; index++) await Promise.resolve()
  expect(reads).toEqual(['ready'])
  created?.({ serverId: 'waiting' })
  for (let index = 0; index < 8; index++) await Promise.resolve()
  expect(reads).toEqual(['ready'])
  statuses.set('waiting', 'connected')
  connections.emitStatus('waiting', 'connected')
  for (let index = 0; index < 8; index++) await Promise.resolve()
  expect(reads).toEqual(['ready', 'waiting'])
  expect(hostRolesStore.rolesFor('waiting')).toEqual(['collaboration'])
})
