import { describe, expect, test } from 'bun:test'
import type { RouteState } from '@solus/client-core/host-route-control'
import type { ReachedMachine } from '@solus/client-core/reached-machines'
import { fleetMachine, machinesByZone, mapLayout, MAP_HEIGHT, OPEN_ZONE_CARDS, type FleetMachineInput } from '@solus/workspace-ui/components/fleet/lib/fleet-model'
import { anchorView, centerOn, fitView, frameHeight, FRAME_HEIGHT, IDENTITY_VIEW, revealRect, toFrame, VIEW_SCALE, zoomView } from '@solus/workspace-ui/components/fleet/lib/fleet-view'
import { foundStop, nextFleetStop, type FleetStop } from '@solus/workspace-ui/components/fleet/lib/fleet-keys'
import { fanRoutes, MAX_WIRES, ROUTE_WIRE_STYLES, type WireRoute } from '@solus/workspace-ui/components/fleet/lib/fleet-routes'
import { introduceAction, introduceBlock, MAX_REACH_LANES, reachEdges, reachLanes, reachNeighbors, reachPaths, REACH_STYLES, type ReachHealth } from '@solus/workspace-ui/components/fleet/lib/fleet-reach'

const base: FleetMachineInput = {
  serverId: 'h1',
  installationId: 'i-h1',
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
const own = (count: number) => Array.from({ length: count }, (_, i) => fleetMachine({ ...base, serverId: `own${i}`, installationId: `i-own${i}`, label: `own-${i}` }))

describe('the frame of the map', () => {
  // WHY: a small fleet must look exactly as before (no zoom, no pan), and a large
  // one must stay readable: shrinking a tall map until no name can be read hides
  // the hosts as surely as cutting them off.
  test('a map that fits is shown as it is', () => {
    expect(fitView({ w: 800, h: 416 }, { w: 800, h: frameHeight(416) })).toEqual({ scale: 1, x: 0, y: 0 })
  })

  test('the frame grows with the map, then stops', () => {
    expect(frameHeight(100)).toBe(FRAME_HEIGHT.min)
    expect(frameHeight(600)).toBe(600)
    expect(frameHeight(5000)).toBe(FRAME_HEIGHT.max)
  })

  test('a tall map shrinks to fit, but never below legible: past that it starts at the top and pans', () => {
    const fit = fitView({ w: 800, h: 1000 }, { w: 800, h: 736 })
    expect(fit.scale).toBeCloseTo(0.736)
    const tall = fitView({ w: 800, h: 4000 }, { w: 800, h: 736 })
    expect(tall.scale).toBe(VIEW_SCALE.legible)
    expect(tall.y).toBe(0)
  })

  test('a zoom keeps the point under the pointer where it is, within the bounds', () => {
    const anchor = { x: 300, y: 200 }
    const zoomed = zoomView(IDENTITY_VIEW, 2, anchor)
    expect(toFrame(zoomed, { x: 300, y: 200 })).toEqual(anchor)
    expect(zoomView(zoomed, 100, anchor).scale).toBe(VIEW_SCALE.max)
    expect(zoomView(zoomed, 0.001, anchor).scale).toBe(VIEW_SCALE.min)
  })

  test('a host Find goes to is centered at a scale it can be read at, however far out the map was', () => {
    const far = { scale: VIEW_SCALE.min, x: 0, y: 0 }
    const centered = centerOn(far, { x: 1000, y: 2000 }, { w: 800, h: 600 })
    expect(centered.scale).toBe(VIEW_SCALE.legible)
    expect(toFrame(centered, { x: 1000, y: 2000 })).toEqual({ x: 400, y: 300 })
  })

  test('focus on a host panned out of view brings it in, and a host in view moves nothing', () => {
    const frame = { w: 800, h: 600 }
    expect(revealRect(IDENTITY_VIEW, { x: 100, y: 100, w: 50, h: 50 }, frame)).toBe(IDENTITY_VIEW)
    const moved = revealRect(IDENTITY_VIEW, { x: 100, y: 900, w: 50, h: 50 }, frame)
    expect(toFrame(moved, { x: 100, y: 950 }).y).toBeLessThanOrEqual(frame.h)
  })

  test('a zone that opens in place stays where it was on screen', () => {
    const view = { scale: 0.8, x: 10, y: -40 }
    const after = anchorView(view, { x: 50, y: 300 }, { x: 50, y: 520 })
    expect(toFrame(after, { x: 50, y: 520 })).toEqual(toFrame(view, { x: 50, y: 300 }))
  })
})

describe('the layout of a large fleet', () => {
  // WHY: a zone with more hosts than cards shows tiles; opening it in place
  // must give every host its own card (up to a page) without moving or
  // shrinking the rest of the map, and must say how many hosts it left out.
  test('an open zone shows a card for each host and makes the map taller', () => {
    const byZone = machinesByZone(own(12))
    const closed = mapLayout(byZone, [], 72)
    expect(closed.height).toBe(MAP_HEIGHT)
    expect(closed.zones[0]!.isFull).toBe(true)
    const open = mapLayout(byZone, [], 72, undefined, { open: new Set(['own']) })
    expect(open.zones[0]!.isOpen).toBe(true)
    expect(open.zones[0]!.rows.filter((row) => row.slot.kind === 'host')).toHaveLength(12)
    expect(open.height).toBeGreaterThan(MAP_HEIGHT)
    for (const row of open.zones[0]!.rows) expect(row.at.y).toBeLessThan(100)
  })

  test('an open zone past a page of cards names the rest, so none is hidden without saying so', () => {
    const open = mapLayout(machinesByZone(own(OPEN_ZONE_CARDS + 7)), [], 72, undefined, { open: new Set(['own']) })
    expect(open.zones[0]!.rows.at(-1)!.slot).toEqual({ kind: 'more', count: 7 })
  })

  test('a zone with room is never "open": there is nothing to fold', () => {
    expect(mapLayout(machinesByZone(own(3)), [], 72, undefined, { open: new Set(['own']) }).zones[0]!.isOpen).toBe(false)
  })

  test('the lanes of the lines between your hosts take room from the links, never from the zones', () => {
    const plain = mapLayout(machinesByZone(own(3)), [], 72)
    const laned = mapLayout(machinesByZone(own(3)), [], 72, undefined, { reachLanes: 3 })
    expect(laned.cardWidth).toBe(plain.cardWidth)
    expect(laned.zones[0]!.box.x).toBeGreaterThan(plain.zones[0]!.box.x)
    expect(laned.lanes.first).toBeLessThan(laned.zones[0]!.box.x)
    expect(laned.lanes.first + 2 * laned.lanes.step).toBeGreaterThan(0)
  })
})

describe('the wires of a host\'s routes', () => {
  // WHY: color alone cannot be the only signal. With colors forced, or for a
  // person who cannot tell amber from red, each kind of trouble must still look
  // different, and must never look like a route that works.
  const states = Object.keys(ROUTE_WIRE_STYLES) as RouteState[]

  test('every route state that is not healthy has a dash of its own', () => {
    const troubled = states.filter((state) => state !== 'in-use' && state !== 'standby')
    const dashes = troubled.map((state) => ROUTE_WIRE_STYLES[state].dash)
    expect(dashes.every((dash) => dash !== null)).toBe(true)
    expect(new Set(dashes).size).toBe(troubled.length)
  })

  test('the route in use is solid and as wide as its traffic; standby is solid and thin', () => {
    expect(ROUTE_WIRE_STYLES['in-use']).toMatchObject({ dash: null, width: null, markBorder: 'solid' })
    expect(ROUTE_WIRE_STYLES.standby).toMatchObject({ dash: null, width: 1 })
  })

  test('a refused or blocked route carries a sign on its mark, not only a color', () => {
    expect(ROUTE_WIRE_STYLES.refused.badge).toBe('refused')
    expect(ROUTE_WIRE_STYLES['different-server'].badge).toBe('refused')
    expect(ROUTE_WIRE_STYLES.blocked.badge).toBe('blocked')
  })

  test('each route is its own wire, in the order the host tries them, and their marks never stand on one another', () => {
    const routes: WireRoute[] = ['lan', 'tailnet', 'public', 'vpn', 'forwarded'].map((kind, i) => ({ url: `http://${kind}`, kind: kind as WireRoute['kind'], state: i === 0 ? 'in-use' : 'standby', stateText: null }))
    const { wires, hidden } = fanRoutes(routes, { x: 40, y: 50 }, { x: 20, y: 30 }, { start: 0.5, end: 2 })
    expect(wires.map((wire) => wire.route.kind)).toEqual(['lan', 'tailnet', 'public', 'vpn'])
    expect(wires).toHaveLength(MAX_WIRES)
    expect(hidden.map((route) => route.kind)).toEqual(['forwarded'])
    const xs = wires.map((wire) => wire.mark.x)
    expect(new Set(xs.map((x) => x.toFixed(2))).size).toBe(wires.length)
    expect(wires[1]!.to.y - wires[0]!.to.y).toBeCloseTo(2)
  })
})

describe('the reach between your hosts', () => {
  // WHY: the map must show which of your hosts reach each other and how each
  // way is doing, one line for two hosts, and a line must look as bad as its
  // worst way. A line that lies here sends an agent to a host it cannot reach.
  const reached = (installationId: string, health?: ReachedMachine['health']): ReachedMachine => ({ installationId, label: installationId, way: health ? 'paired' : 'introduced', health: health ?? null })
  const serverIdOf = (installationId: string) => installationId.replace('i-', '')

  test('two hosts that reach each other are one two-way line; a one-way reach is one line with one direction', () => {
    const edges = reachEdges([
      { serverId: 'own0', reached: [reached('i-own1'), reached('i-own2')] },
      { serverId: 'own1', reached: [reached('i-own0')] },
    ], serverIdOf)
    expect(edges).toHaveLength(2)
    const both = edges.find((edge) => edge.b === 'own1')!
    expect([both.forward !== null, both.back !== null]).toEqual([true, true])
    const oneWay = edges.find((edge) => edge.b === 'own2')!
    expect([oneWay.forward !== null, oneWay.back !== null]).toEqual([true, false])
  })

  test('a line wears the health of its worse way', () => {
    const [edge] = reachEdges([
      { serverId: 'own0', reached: [reached('i-own1', { kind: 'working', expiresInDays: null })] },
      { serverId: 'own1', reached: [reached('i-own0', { kind: 'failing', detail: 'refused' })] },
    ], serverIdOf)
    expect(edge!.health).toBe('failing')
  })

  test('a reached machine that is not on the map, or the host itself, has no line', () => {
    expect(reachEdges([{ serverId: 'own0', reached: [reached('i-elsewhere'), reached('i-own0')] }], (id) => (id === 'i-own0' ? 'own0' : undefined))).toEqual([])
  })

  test('each kind of trouble has its own dash, and a working line has none', () => {
    const troubled: ReachHealth[] = ['expiring', 'failing', 'expired']
    expect(REACH_STYLES.working.dash).toBeNull()
    expect(new Set(troubled.map((health) => REACH_STYLES[health].dash)).size).toBe(troubled.length)
    expect(troubled.every((health) => REACH_STYLES[health].dash !== null)).toBe(true)
  })

  test('selecting a host lights the hosts one step away, and does not follow a reach through', () => {
    const edges = reachEdges([
      { serverId: 'own0', reached: [reached('i-own1')] },
      { serverId: 'own1', reached: [reached('i-own2')] },
    ], serverIdOf)
    expect([...reachNeighbors(edges, 'own0')]).toEqual(['own1'])
  })

  test('lines share a lane only where they do not overlap, and short lines run nearest the cards', () => {
    const edges = reachEdges([
      { serverId: 'own0', reached: [reached('i-own1'), reached('i-own3')] },
      { serverId: 'own2', reached: [reached('i-own3')] },
    ], serverIdOf)
    const y = new Map([['own0', 10], ['own1', 20], ['own2', 30], ['own3', 40]])
    const { lanes, count } = reachLanes(edges, y)
    expect(lanes.get('own0\nown1')).toBe(0)
    expect(lanes.get('own2\nown3')).toBe(0)
    expect(lanes.get('own0\nown3')).toBe(1)
    expect(count).toBe(2)
  })

  test('however many lines there are, the lanes stop at their bound', () => {
    const sources = Array.from({ length: 8 }, (_, i) => ({ serverId: `own${i}`, reached: Array.from({ length: 8 }, (_, j) => reached(`i-own${j}`)) }))
    const edges = reachEdges(sources, serverIdOf)
    const y = new Map(sources.map((source, i) => [source.serverId, i * 10]))
    const { lanes } = reachLanes(edges, y)
    expect(Math.max(...lanes.values())).toBeLessThan(MAX_REACH_LANES)
  })

  test('a line ends in an arrowhead at each host that is reached, and the lines into one card spread apart', () => {
    const edges = reachEdges([
      { serverId: 'own0', reached: [reached('i-own1'), reached('i-own2')] },
    ], serverIdOf)
    const cards = new Map([['own0', { edge: 10, y: 10 }], ['own1', { edge: 10, y: 20 }], ['own2', { edge: 10, y: 30 }]])
    const { lanes } = reachLanes(edges, new Map([...cards].map(([id, card]) => [id, card.y])))
    const paths = reachPaths(edges, cards, lanes, (lane) => 5 - lane, 1)
    expect(paths.map((path) => path.ends.map((end) => end.isReached))).toEqual([[false, true], [false, true]])
    const intoOwn0 = paths.map((path) => path.ends[0].point.y)
    expect(new Set(intoOwn0).size).toBe(2)
  })
})

describe('introducing hosts on the map', () => {
  // WHY: a drop must do what the person aimed at: one host, or every selected
  // host, and never a host this device cannot introduce. When nothing can be
  // done, the person must read why where they dropped it.
  const machines = new Map([
    ...own(4).map((machine) => [machine.serverId, machine] as const),
    ['cloud0', fleetMachine({ ...base, serverId: 'cloud0', label: 'cloud-0', isManaged: true })] as const,
    ['down0', fleetMachine({ ...base, serverId: 'down0', label: 'down-0', readiness: 'unreachable' })] as const,
  ])
  const blockOf = (serverId: string) => introduceBlock(machines.get(serverId)!, true)
  const labelOf = (serverId: string) => machines.get(serverId)!.label
  const none = new Set<string>()

  test('a drop on one host introduces the two', () => {
    expect(introduceAction({ sourceId: 'own0', dropId: 'own1', selected: none, edges: [], blockOf, labelOf })).toEqual({ kind: 'introduce', sourceId: 'own0', targetIds: ['own1'], skipped: [] })
  })

  test('a drop on one of several selected hosts introduces the source to each of them, but not to itself', () => {
    const selected = new Set(['own0', 'own2', 'own3'])
    expect(introduceAction({ sourceId: 'own0', dropId: 'own2', selected, edges: [], blockOf, labelOf })).toMatchObject({ targetIds: ['own2', 'own3'] })
  })

  test('a drop outside the selection introduces only the host it landed on', () => {
    const selected = new Set(['own2', 'own3'])
    expect(introduceAction({ sourceId: 'own0', dropId: 'own1', selected, edges: [], blockOf, labelOf })).toMatchObject({ targetIds: ['own1'] })
  })

  test('a Solus Cloud machine, a shared host, a host that does not answer, or one this device does not own says why', () => {
    expect(introduceAction({ sourceId: 'own0', dropId: 'cloud0', selected: none, edges: [], blockOf, labelOf })).toEqual({ kind: 'explain', message: expect.stringContaining('Solus Cloud') })
    expect(introduceAction({ sourceId: 'own0', dropId: 'down0', selected: none, edges: [], blockOf, labelOf })).toEqual({ kind: 'explain', message: expect.stringContaining('does not answer') })
    expect(introduceBlock(fleetMachine({ ...base, principal: 'guest' }), false)).toContain('shared')
    expect(introduceBlock(machines.get('own1')!, false)).toContain('not the owner')
  })

  test('of several selected hosts, the ones that can be introduced are, and the rest are named', () => {
    const selected = new Set(['own1', 'cloud0'])
    expect(introduceAction({ sourceId: 'own0', dropId: 'own1', selected, edges: [], blockOf, labelOf })).toMatchObject({ kind: 'introduce', targetIds: ['own1'], skipped: [expect.stringContaining('cloud-0')] })
  })

  test('two hosts that already reach each other both ways are left alone, and the drop says so', () => {
    const edges = reachEdges([
      { serverId: 'own0', reached: [{ installationId: 'i-own1', label: 'own-1', way: 'introduced', health: null }] },
      { serverId: 'own1', reached: [{ installationId: 'i-own0', label: 'own-0', way: 'introduced', health: null }] },
    ], (id) => id.replace('i-', ''))
    expect(introduceAction({ sourceId: 'own0', dropId: 'own1', selected: none, edges, blockOf, labelOf })).toEqual({ kind: 'explain', message: 'own-0 and own-1 already reach each other.' })
  })

  test('a drop on the host it started from does nothing', () => {
    expect(introduceAction({ sourceId: 'own0', dropId: 'own0', selected: none, edges: [], blockOf, labelOf })).toBeNull()
  })
})

describe('the keys of the map', () => {
  // WHY: Solus is keyboard first. On the map an arrow key must go to the host
  // the person sees in that direction, card or tile, and Find must go to each
  // match in turn.
  const stops: FleetStop[] = [
    { id: 'a', x: 0, y: 0, w: 100, h: 40 },
    { id: 'b', x: 0, y: 50, w: 100, h: 40 },
    { id: 'c', x: 0, y: 100, w: 100, h: 40 },
    { id: 'hub', x: 300, y: 50, w: 120, h: 50 },
    { id: 'r', x: 600, y: 0, w: 100, h: 40 },
  ]

  test('up and down keep to the column, in order', () => {
    expect(nextFleetStop(stops, 'a', 'down')).toBe('b')
    expect(nextFleetStop(stops, 'b', 'down')).toBe('c')
    expect(nextFleetStop(stops, 'c', 'down')).toBeNull()
    expect(nextFleetStop(stops, 'c', 'up')).toBe('b')
  })

  test('left and right step across to the nearest host on that side', () => {
    expect(nextFleetStop(stops, 'b', 'right')).toBe('hub')
    expect(nextFleetStop(stops, 'hub', 'right')).toBe('r')
    expect(nextFleetStop(stops, 'hub', 'left')).toBe('b')
  })

  test('with nothing focused, an arrow starts at the first host', () => {
    expect(nextFleetStop(stops, null, 'down')).toBe('a')
  })

  test('Find steps through its matches in name order, and round again', () => {
    const matches = [{ label: 'zeta' }, { label: 'alpha' }, { label: 'mid' }]
    expect([0, 1, 2, 3].map((index) => foundStop(matches, index)?.label)).toEqual(['alpha', 'mid', 'zeta', 'alpha'])
    expect(foundStop([], 0)).toBeNull()
  })
})
