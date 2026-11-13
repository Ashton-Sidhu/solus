import { describe, expect, test } from 'bun:test'
import {
  fleetMachine,
  fleetStateOf,
  isZoneFull,
  isZoneTroubled,
  machinesByZone,
  needsAttention,
  recommendedAddWay,
  rollup,
  tileFill,
  travelSeconds,
  ZONES,
  attentionRows,
  type FleetMachineInput,
} from '@solus/workspace-ui/components/fleet/lib/fleet-model'

// WHY: docs/plans/host-fleet.md D2–D8. The map puts each host in the zone of the
// route this device reaches it by, says its state as one icon, keeps healthy hosts
// green and only problems loud, switches a full zone to tiles, and the Add page
// recommends one way. These answers are what the map, the summary, and the host
// page all read, so a wrong one shows the person a wrong fleet.

const base: FleetMachineInput = {
  serverId: 'h1',
  label: 'studio-mini',
  isThisDevice: false,
  isManaged: false,
  principal: 'local-owner',
  readiness: 'ready',
  routeKind: 'lan',
  sessions: 0,
  load: { cpu: 20, memory: 40, latencyMs: 4 },
  hasUpdate: false,
  needsSetup: false,
}

describe('the zone of a host', () => {
  test('is the route this device reaches it by', () => {
    expect(fleetMachine(base).zone).toBe('own')
    expect(fleetMachine({ ...base, routeKind: 'forwarded' }).zone).toBe('forwarded')
    expect(fleetMachine({ ...base, routeKind: 'tunnel' }).zone).toBe('own')
  })

  test('a Solus Cloud machine is in the cloud whatever its route, grouped by its organization', () => {
    const machine = fleetMachine({ ...base, isManaged: true, routeKind: 'tunnel', organizationName: 'Acme' })
    expect(machine.zone).toBe('cloud')
    expect(machine.group).toBe('Acme')
  })

  test('a host someone else shares is shared, grouped by its owner', () => {
    const machine = fleetMachine({ ...base, principal: 'org-member', ownerName: 'Priya' })
    expect(machine.zone).toBe('shared')
    expect(machine.group).toBe('Priya')
    expect(fleetMachine({ ...base, principal: 'guest' }).zone).toBe('shared')
  })

  test('this device is the center, not a zone', () => {
    expect(fleetMachine({ ...base, isThisDevice: true }).zone).toBe('device')
    expect(machinesByZone([fleetMachine({ ...base, isThisDevice: true })]).own).toHaveLength(0)
  })
})

describe('the state of a host', () => {
  test('a cloud machine that is stopped is stopped, not unreachable', () => {
    expect(fleetStateOf('unreachable', 'stopped', 0)).toBe('stopped')
    expect(fleetStateOf('unreachable', 'starting', 0)).toBe('starting')
    expect(fleetStateOf('unreachable', 'failed', 0)).toBe('unreachable')
  })

  test('a host that answers is running while sessions work on it, else idle', () => {
    expect(fleetStateOf('ready', undefined, 2)).toBe('running')
    expect(fleetStateOf('ready', 'ready', 0)).toBe('idle')
    expect(fleetStateOf('refused', undefined, 0)).toBe('unreachable')
    expect(fleetStateOf('gone', undefined, 0)).toBe('unreachable')
  })

  test('a host that does not answer shows no load and no sessions, so no number lies', () => {
    const machine = fleetMachine({ ...base, readiness: 'reconnecting', sessions: 3 })
    expect(machine).toMatchObject({ state: 'reconnecting', sessions: 0, cpu: null, latencyMs: null })
  })

  test('wants the person when it is down, needs a sign-in, or has an update', () => {
    expect(needsAttention(fleetMachine(base))).toBe(false)
    expect(needsAttention(fleetMachine({ ...base, readiness: 'unreachable' }))).toBe(true)
    expect(needsAttention(fleetMachine({ ...base, needsSetup: true }))).toBe(true)
    expect(needsAttention(fleetMachine({ ...base, hasUpdate: true }))).toBe(true)
  })
})

describe('a zone', () => {
  const cloud = ZONES.find((zone) => zone.id === 'cloud')!

  test('shows cards while they fit, then tiles', () => {
    expect(isZoneFull(cloud, cloud.cardCapacity)).toBe(false)
    expect(isZoneFull(cloud, cloud.cardCapacity + 1)).toBe(true)
  })

  test('counts its hosts by state, and its link turns amber only when more than a tenth are down', () => {
    const up = Array.from({ length: 18 }, (_, i) => fleetMachine({ ...base, serverId: `up${i}`, sessions: i % 2 }))
    const down = [fleetMachine({ ...base, serverId: 'd1', readiness: 'unreachable' }), fleetMachine({ ...base, serverId: 'd2', readiness: 'reconnecting' })]
    const summary = rollup([...up, ...down])
    expect(summary).toMatchObject({ total: 20, answering: 18, unreachable: 1, reconnecting: 1, sessions: 9 })
    expect(isZoneTroubled(summary)).toBe(false)
    expect(isZoneTroubled(rollup([...up.slice(0, 8), ...down]))).toBe(true)
  })
})

describe('color and motion', () => {
  test('a healthy host is green when idle and terracotta when running; a problem has its own color in every mode', () => {
    expect(tileFill(fleetMachine(base), 'status')).toContain('--success')
    expect(tileFill(fleetMachine({ ...base, sessions: 2 }), 'status')).toContain('--solus-status-running')
    for (const mode of ['status', 'cpu', 'sessions'] as const) {
      expect(tileFill(fleetMachine({ ...base, readiness: 'unreachable' }), mode)).toBe('var(--solus-status-error)')
    }
    expect(tileFill(fleetMachine({ ...base, isManaged: true, managedState: 'stopped' }), 'status')).toBeNull()
  })

  test('a busier link moves its light faster, but never faster than 3.5 s a trip', () => {
    expect(travelSeconds(1)).toBeGreaterThan(travelSeconds(40))
    expect(travelSeconds(10_000)).toBe(3.5)
  })
})

describe('the way the Add page recommends', () => {
  test('a machine in reach first, then a cloud machine, then linking your own', () => {
    expect(recommendedAddWay(2, true)).toBe('nearby')
    expect(recommendedAddWay(0, true)).toBe('cloud')
    expect(recommendedAddWay(0, false)).toBe('link')
  })
})

describe('the Needs attention list', () => {
  test('lists each host once, for its most urgent problem, while there are a handful', () => {
    const rows = attentionRows([
      fleetMachine({ ...base, serverId: 'a', label: 'a', readiness: 'unreachable', hasUpdate: true }),
      fleetMachine({ ...base, serverId: 'b', label: 'b', needsSetup: true }),
      fleetMachine({ ...base, serverId: 'c', label: 'c' }),
    ])
    expect(rows.map((row) => [row.kind, row.title])).toEqual([['unreachable', 'a'], ['signin', 'b']])
  })

  test('groups a large fleet by kind, so the list stays short', () => {
    const many = Array.from({ length: 12 }, (_, i) => fleetMachine({ ...base, serverId: `h${i}`, label: `h${i}`, hasUpdate: true }))
    const rows = attentionRows([...many, fleetMachine({ ...base, serverId: 'x', label: 'x', readiness: 'unreachable' })])
    expect(rows.map((row) => [row.kind, row.serverIds.length])).toEqual([['unreachable', 1], ['update', 12]])
    expect(rows[1]!.note).toBe('h0, h1, h2, and 9 more')
  })
})
