import { describe, expect, test } from 'bun:test'
import { aggregateConnectionSessionsByDevice } from '../../src/main/server/handlers/connections-handlers'

describe('connection session aggregation', () => {
  test('groups multiple sockets from one trusted device into one row', () => {
    const rows = aggregateConnectionSessionsByDevice([
      { id: 'socket-a', deviceLabel: 'This Mac', deviceId: 'local-device', connectedAt: 300 },
      { id: 'socket-b', deviceLabel: 'This Mac', deviceId: 'local-device', connectedAt: 100 },
      { id: 'socket-c', deviceLabel: 'Phone', deviceId: 'phone-device', connectedAt: 200 },
    ])

    expect(rows).toEqual([
      {
        id: 'device:local-device',
        deviceLabel: 'This Mac',
        deviceId: 'local-device',
        connectedAt: 100,
        connectionCount: 2,
        connectionIds: ['socket-a', 'socket-b'],
      },
      {
        id: 'device:phone-device',
        deviceLabel: 'Phone',
        deviceId: 'phone-device',
        connectedAt: 200,
        connectionCount: 1,
        connectionIds: ['socket-c'],
      },
    ])
  })

  test('keeps unauthenticated dev sockets separate because they have no device identity', () => {
    const rows = aggregateConnectionSessionsByDevice([
      { id: 'socket-a', deviceLabel: 'Web', deviceId: null, connectedAt: 100 },
      { id: 'socket-b', deviceLabel: 'Web', deviceId: null, connectedAt: 200 },
    ])

    expect(rows.map((row) => row.id)).toEqual(['socket-a', 'socket-b'])
    expect(rows.map((row) => row.connectionCount)).toEqual([1, 1])
  })
})
