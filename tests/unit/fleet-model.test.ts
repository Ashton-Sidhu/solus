import { describe, expect, test } from 'bun:test'
import type { FoundMachine } from '@solus/workspace-ui/components/fleet/lib/discover'
import {
  fleetMachine,
  fleetStateOf,
  isZoneFull,
  machinesByZone,
  mapLayout,
  needsAttention,
  rollup,
  tileFill,
  travelSeconds,
  ZONES,
  attentionRows,
  type FleetMachineInput,
} from '@solus/workspace-ui/components/fleet/lib/fleet-model'

// WHY: The map puts each host in the zone of the
// route this device reaches it by, says its state as one icon, keeps healthy hosts
// green and only problems loud, switches a full zone to tiles, and the Add page
// recommends one way. These answers are what the map, the summary, and the host
// page all read, so a wrong one shows the person a wrong fleet.

const base: FleetMachineInput = {
  serverId: 'h1',
  label: 'studio-mini',
  isThisDevice: false,
  isCloud: false,
  hasManagedCompute: false,
  principal: 'local-owner',
  readiness: 'ready',
  routeKind: 'lan',
  sessions: 0,
  load: { cpu: 20, memory: 40, latencyMs: 4 },
  hasUpdate: false,
}

describe('the zone of a host', () => {
  test('a machine of yours is in Your machines whatever its route: an SSH or WSL host is not a zone of its own', () => {
    expect(fleetMachine(base).zone).toBe('own')
    expect(fleetMachine({ ...base, routeKind: 'forwarded' }).zone).toBe('own')
    expect(fleetMachine({ ...base, routeKind: 'tunnel' }).zone).toBe('own')
  })

  test('a cloud machine is in the cloud whatever its route, grouped by its organization', () => {
    const machine = fleetMachine({ ...base, isCloud: true, routeKind: 'tunnel', organizationName: 'Acme' })
    expect(machine.zone).toBe('cloud')
    expect(machine.group).toBe('Acme')
  })

  test('a cloud machine that its operator runs is in the cloud with no lifecycle: the connection says its state', () => {
    // WHY: the kind decides whose machine it is; only managed compute has a lifecycle.
    // A Start control on a machine Solus Cloud cannot start would do nothing.
    const down = fleetMachine({ ...base, isCloud: true, routeKind: 'tunnel', readiness: 'unreachable' })
    expect(down).toMatchObject({ zone: 'cloud', isCloud: true, hasManagedCompute: false, state: 'unreachable' })
    const stopped = fleetMachine({ ...base, isCloud: true, hasManagedCompute: true, managedState: 'stopped', readiness: 'unreachable' })
    expect(stopped).toMatchObject({ zone: 'cloud', hasManagedCompute: true, state: 'stopped' })
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

  test('wants the person when it is down or has an update of Solus or an agent', () => {
    expect(needsAttention(fleetMachine(base))).toBe(false)
    expect(needsAttention(fleetMachine({ ...base, readiness: 'unreachable' }))).toBe(true)
    expect(needsAttention(fleetMachine({ ...base, hasUpdate: true }))).toBe(true)
  })
})

describe('a zone', () => {
  const cloud = ZONES.find((zone) => zone.id === 'cloud')!

  test('shows cards while they fit, then tiles', () => {
    expect(isZoneFull(cloud, cloud.cardCapacity)).toBe(false)
    expect(isZoneFull(cloud, cloud.cardCapacity + 1)).toBe(true)
  })

  test('counts its hosts by state', () => {
    const up = Array.from({ length: 18 }, (_, i) => fleetMachine({ ...base, serverId: `up${i}`, sessions: i % 2 }))
    const down = [fleetMachine({ ...base, serverId: 'd1', readiness: 'unreachable' }), fleetMachine({ ...base, serverId: 'd2', readiness: 'reconnecting' })]
    const summary = rollup([...up, ...down])
    expect(summary).toMatchObject({ total: 20, answering: 18, unreachable: 1, reconnecting: 1, sessions: 9 })
  })
})

describe('the layout of the map', () => {
  // WHY: the map has one height and no scroll (D4), and its pane can be 37.5rem
  // or twice that. A zone that leaves the map, covers its neighbor or this
  // device, or holds a card outside itself hides a host from the person, so
  // every count of hosts and every width must give a layout that fits.
  const hosts = (count: number, zone: string, input: Partial<FleetMachineInput>) =>
    Array.from({ length: count }, (_, i) => fleetMachine({ ...base, ...input, serverId: `${zone}${i}` }))
  const fleet = (own: number, cloud: number, shared: number) =>
    machinesByZone([
      ...hosts(own, 'own', {}),
      ...hosts(cloud, 'cloud', { isCloud: true }),
      ...hosts(shared, 'shared', { principal: 'guest' }),
    ])
  const nearby: FoundMachine = { kind: 'ssh', key: 'ssh:lab', name: 'lab', source: 'ssh-config', detail: 'lab', zone: 'own', sshTarget: 'lab' }
  const WIDTHS = [0, 37.5, 48, 72]

  test('each zone stays in the map, clear of the zone below it, with each card inside it, for each count of hosts', () => {
    for (const count of [0, 1, 2, 3, 4, 5, 6, 40]) {
      const { zones } = mapLayout(fleet(count, count, count), [], 48)
      for (const { zone, box, rows } of zones) {
        expect(box.y).toBeGreaterThan(0)
        expect(box.y + box.h).toBeLessThan(100)
        const below = zones[zones.findIndex((other) => other.zone.id === zone.id) + 1]
        if (below && below.zone.isViaTunnel === zone.isViaTunnel) expect(below.box.y).toBeGreaterThan(box.y + box.h)
        for (const { at } of rows) {
          expect(at.y).toBeGreaterThan(box.y)
          expect(at.y).toBeLessThan(box.y + box.h)
        }
      }
    }
  })

  test('at each width, the zones, this device, and the tunnel are in order across the map, with room for links between them', () => {
    for (const width of WIDTHS) {
      const { zones, hub, tunnel } = mapLayout(fleet(1, 1, 1), [], width)
      const [own, cloud] = zones
      expect(own!.box.x).toBeGreaterThan(0)
      expect(own!.box.x + own!.box.w).toBeLessThan(hub.x - hub.w / 2)
      expect(hub.x + hub.w / 2).toBeLessThan(tunnel.x)
      expect(tunnel.x).toBeLessThan(cloud!.box.x)
      expect(cloud!.box.x + cloud!.box.w).toBeLessThan(100)
    }
  })

  test('a wider map gives its room to the links, not to wider cards', () => {
    const narrow = mapLayout(fleet(1, 1, 0), [], 48)
    const wide = mapLayout(fleet(1, 1, 0), [], 72)
    const linkRoom = (layout: typeof narrow) => layout.zones[1]!.box.x - layout.zones[0]!.box.x - layout.zones[0]!.box.w - layout.hub.w
    expect((wide.cardWidth * 72) / 100).toBeLessThan(15)
    expect((linkRoom(wide) * 72) / 100).toBeGreaterThan(2 * ((linkRoom(narrow) * 48) / 100))
  })

  test('a zone grows with its rows, and its side stays centered on this device', () => {
    const one = mapLayout(fleet(1, 0, 0), [], 48)
    const three = mapLayout(fleet(3, 0, 0), [], 48)
    expect(three.zones[0]!.box.h).toBeGreaterThan(one.zones[0]!.box.h)
    for (const { zones, hub } of [one, three]) {
      const [own, cloud, shared] = zones
      expect(own!.box.y + own!.box.h / 2).toBeCloseTo(hub.y)
      expect((cloud!.box.y + shared!.box.y + shared!.box.h) / 2).toBeCloseTo(hub.y)
    }
  })

  test('a zone with room shows its hosts first, then a found machine where it would go, and never more rows than its capacity', () => {
    const [own] = mapLayout(fleet(4, 0, 0), [nearby, { ...nearby, key: 'ssh:lab2' }], 48).zones
    expect(own!.rows.map((row) => row.slot.kind)).toEqual(['host', 'host', 'host', 'host', 'found'])
  })

  test('a zone counts the found machines it has no row for, so the map never hides one that Discover found', () => {
    // WHY: the map is the only place the fleet view shows found machines (D7).
    const found = [nearby, { ...nearby, key: 'ssh:lab2' }, { ...nearby, key: 'ssh:lab3' }]
    expect(mapLayout(fleet(4, 0, 0), found, 48).zones[0]!.moreFound).toBe(2)
    expect(mapLayout(fleet(1, 0, 0), found, 48).zones[0]!.moreFound).toBe(0)
    expect(mapLayout(fleet(40, 0, 0), found, 48).zones[0]!.moreFound).toBe(3)
    expect(mapLayout(fleet(4, 0, 0), found, 48).zones[1]!.moreFound).toBe(0)
  })

  test('an empty zone says what it is for: a way to add a host, or that no host is shared', () => {
    const [own, cloud, shared] = mapLayout(fleet(0, 0, 0), [], 48).zones.map((zone) => zone.rows.map((row) => row.slot))
    expect(own).toEqual([{ kind: 'add', way: 'pair' }])
    expect(cloud).toEqual([{ kind: 'add', way: 'cloud' }])
    expect(shared).toEqual([{ kind: 'empty' }])
  })

  test('a zone whose read has not answered says so, and offers no way to add a host it cannot see yet', () => {
    // WHY: plans/033 §3 Q2. Nothing is kept from an earlier start, so before the
    // first directory read Solus Cloud is empty: it must read as loading, and as
    // failed with Retry, never as a fleet with no cloud machines.
    const answers = { own: 'ready', cloud: 'loading', shared: 'failed' } as const
    const [own, cloud, shared] = mapLayout(fleet(0, 0, 0), [{ ...nearby, zone: 'cloud' }], 48, answers).zones.map((zone) => zone.rows.map((row) => row.slot.kind === 'unread' ? row.slot : row.slot.kind))
    expect(own).toEqual(['add'])
    expect(cloud).toEqual([{ kind: 'unread', state: 'loading' }])
    expect(shared).toEqual([{ kind: 'unread', state: 'failed' }])
  })

  test('a full zone shows no cards, and keeps the height of its capacity for its tiles', () => {
    const atCapacity = mapLayout(fleet(5, 0, 0), [], 48).zones[0]!
    const full = mapLayout(fleet(40, 0, 0), [nearby], 48).zones[0]!
    expect(full.isFull).toBe(true)
    expect(full.rows).toEqual([])
    expect(full.box.h).toBeCloseTo(atCapacity.box.h)
  })

  test('a link ends on the edge of its card that faces this device', () => {
    for (const width of WIDTHS) {
      const { zones, hub } = mapLayout(fleet(1, 1, 1), [], width)
      for (const { zone, rows, linkStart } of zones) {
        const { at, port } = rows[0]!
        expect(port.y).toBeCloseTo(at.y)
        expect(Math.abs(port.x - linkStart.x)).toBeLessThan(Math.abs(at.x - linkStart.x))
        expect(port.x > hub.x).toBe(zone.isViaTunnel)
      }
    }
  })
})

describe('color and motion', () => {
  test('a healthy host is green when idle and terracotta when running; a problem has its own color in every mode', () => {
    expect(tileFill(fleetMachine(base), 'status')).toContain('--success')
    expect(tileFill(fleetMachine({ ...base, sessions: 2 }), 'status')).toContain('--solus-status-running')
    for (const mode of ['status', 'cpu', 'sessions'] as const) {
      expect(tileFill(fleetMachine({ ...base, readiness: 'unreachable' }), mode)).toBe('var(--solus-status-error)')
    }
    expect(tileFill(fleetMachine({ ...base, isCloud: true, hasManagedCompute: true, managedState: 'stopped' }), 'status')).toBeNull()
  })

  test('a busier link moves its light faster, but never faster than 3.5 s a trip', () => {
    expect(travelSeconds(1)).toBeGreaterThan(travelSeconds(40))
    expect(travelSeconds(10_000)).toBe(3.5)
  })
})

describe('the Needs attention list', () => {
  test('lists each host once, for its most urgent problem, while there are a handful', () => {
    const rows = attentionRows([
      fleetMachine({ ...base, serverId: 'a', label: 'a', readiness: 'unreachable', hasUpdate: true }),
      fleetMachine({ ...base, serverId: 'b', label: 'b', hasUpdate: true }),
      fleetMachine({ ...base, serverId: 'c', label: 'c' }),
    ])
    expect(rows.map((row) => [row.kind, row.title])).toEqual([['unreachable', 'a'], ['update', 'b']])
  })

  test('groups a large fleet by kind, so the list stays short', () => {
    const many = Array.from({ length: 12 }, (_, i) => fleetMachine({ ...base, serverId: `h${i}`, label: `h${i}`, hasUpdate: true }))
    const rows = attentionRows([...many, fleetMachine({ ...base, serverId: 'x', label: 'x', readiness: 'unreachable' })])
    expect(rows.map((row) => [row.kind, row.serverIds.length])).toEqual([['unreachable', 1], ['update', 12]])
    expect(rows[1]!.note).toBe('h0, h1, h2, and 9 more')
  })
})
