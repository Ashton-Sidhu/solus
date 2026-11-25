import type { AnswerState } from '@solus/client-core/host-catalog'
import type { HostReadiness, HostReadinessAction, HostReadinessCopy } from '@solus/client-core/host-readiness'
import type { RouteKind } from '@solus/contracts/host-routes'
import type { HostOperatingSystem } from '@solus/contracts/types'
import type { ManagedHostLifecycle } from '@solus/contracts/uplink'
import type { FoundMachine } from './discover'

/**
 * The fleet view's model: every host as one
 * `FleetMachine`, the zone it is in, its state, and the numbers the
 * map and the summary show. Pure, so the map, the summary, and the tests read the
 * same answers.
 */

/** A zone is whose machine a host is: yours, Solus Cloud's, or one that someone shares with you. `device` is this device itself, at the map's center. */
export type FleetZoneId = 'own' | 'cloud' | 'shared'

/** What a host is doing now, as one icon shows it. */
export type FleetState = 'running' | 'idle' | 'checking' | 'starting' | 'reconnecting' | 'unreachable' | 'stopped'

/** The four colors the map uses. Healthy is green; only a problem gets amber or red. */
export type FleetTone = 'ok' | 'warn' | 'bad' | 'off'

export interface FleetMachine {
  serverId: string
  /** The identity every client of the host, and every agent tool, knows it by; null before the host says it. */
  installationId: string | null
  label: string
  os?: HostOperatingSystem
  /** A cloud machine of an organization: its mark is the cloud, and it is in the cloud zone. */
  isCloud: boolean
  /** Solus Cloud operates its compute: it can start, stop, and restart. */
  hasManagedCompute: boolean
  /** This device: the center of the map, not a zone. */
  isThisDevice: boolean
  zone: FleetZoneId | 'device'
  /** The organization or owner a host is grouped under inside its zone; null when the zone has no groups. */
  group: string | null
  state: FleetState
  /** Sessions working on this host now. */
  sessions: number
  /** 0 to 100; null when the host has not answered a load read. */
  cpu: number | null
  memory: number | null
  /** The round trip of the last load read, in milliseconds. */
  latencyMs: number | null
  /** The traffic on this device's connection to the host; null while it does not answer or before two reads. */
  traffic: Traffic | null
  /** The kind of the route this device dials the host on. */
  routeKind: RouteKind | null
  /** The route this device is on, or tries, now, and how that goes; null when it dials none. Its line names it. */
  routeInUse: RouteInUse | null
  /** Where the host answers; null for this device. */
  address: string | null
  hasUpdate: boolean
  needsSetup: boolean
  /**
   * Why a host that does not answer does not, in the words every client uses
   * (`hostReadinessCopy`): "Needs pairing", "Different server", "Not running",
   * "No address", "Offline", with the one action for it. Null while it answers,
   * and while its cloud lifecycle says it (stopped, starting).
   */
  problem: HostReadinessCopy | null
}

/** KB/s each way on one connection: `down` from the host to this device, `up` to it. */
export interface Traffic {
  down: number
  up: number
}

export interface RouteInUse {
  kind: RouteKind
  phase: 'in-use' | 'connecting' | 'refused'
}

export interface FleetMachineInput {
  serverId: string
  installationId?: string
  label: string
  os?: HostOperatingSystem
  isThisDevice: boolean
  isCloud: boolean
  hasManagedCompute: boolean
  /** How this client is admitted there: a member or guest uses a host someone else shares. */
  principal?: 'local-owner' | 'remote-owner' | 'org-member' | 'guest' | 'runner' | 'system'
  ownerName?: string
  organizationName?: string
  readiness: HostReadiness
  managedState?: ManagedHostLifecycle
  routeKind: RouteKind | null
  /** The kind of the route the link dials now; left out when it dials none. */
  dialedRouteKind?: RouteKind
  /** Where the host answers; left out for this device. */
  address?: string
  sessions: number
  load: { cpu: number | null; memory: number | null; latencyMs: number | null; traffic?: Traffic | null } | null
  hasUpdate: boolean
  needsSetup: boolean
  /** The readiness words of the host (`hostReadinessCopy`). */
  readinessCopy?: HostReadinessCopy
}

export function fleetMachine(input: FleetMachineInput): FleetMachine {
  const state = fleetStateOf(input.readiness, input.managedState, input.sessions)
  const zone = zoneOf(input)
  const isAnswering = state === 'running' || state === 'idle'
  return {
    serverId: input.serverId,
    installationId: input.installationId ?? null,
    label: input.label,
    os: input.os,
    isCloud: input.isCloud,
    hasManagedCompute: input.hasManagedCompute,
    isThisDevice: input.isThisDevice,
    zone,
    group: groupOf(zone, input),
    state,
    sessions: isAnswering ? input.sessions : 0,
    ...loadOf(input, isAnswering),
    routeKind: input.routeKind,
    routeInUse: input.isThisDevice || !input.dialedRouteKind ? null : routeInUseOf(input.dialedRouteKind, input.readiness),
    address: input.address ?? null,
    hasUpdate: input.hasUpdate,
    needsSetup: input.needsSetup,
    problem: problemOf(input, state),
  }
}

/** The readings of a host that answers; none for one that does not, so no number lies. Latency and traffic are of a connection, and this device has none to itself. */
function loadOf(input: FleetMachineInput, isAnswering: boolean): Pick<FleetMachine, 'cpu' | 'memory' | 'latencyMs' | 'traffic'> {
  if (!isAnswering) return { cpu: null, memory: null, latencyMs: null, traffic: null }
  const isRemote = !input.isThisDevice
  return {
    cpu: input.load?.cpu ?? null,
    memory: input.load?.memory ?? null,
    latencyMs: isRemote ? input.load?.latencyMs ?? null : null,
    traffic: isRemote ? input.load?.traffic ?? null : null,
  }
}

/** The readiness words of a host that does not answer; none while its cloud lifecycle says it (stopped, starting). */
function problemOf(input: FleetMachineInput, state: FleetState): HostReadinessCopy | null {
  const isDown = state === 'unreachable' || state === 'reconnecting' || state === 'checking'
  return input.readiness !== 'ready' && isDown ? input.readinessCopy ?? null : null
}

/** A host that answers is on its route; one that is checking, reconnecting, or refused shows the route it tries. An unreachable host is on none. */
function routeInUseOf(kind: RouteKind, readiness: HostReadiness): RouteInUse | null {
  if (readiness === 'ready') return { kind, phase: 'in-use' }
  if (readiness === 'checking' || readiness === 'reconnecting') return { kind, phase: 'connecting' }
  if (readiness === 'refused') return { kind, phase: 'refused' }
  return null
}

/** A cloud machine and a host someone else shares have their own zone. Each other host is yours, whatever its route: an SSH or WSL host too. */
function zoneOf(input: FleetMachineInput): FleetMachine['zone'] {
  if (input.isThisDevice) return 'device'
  if (input.isCloud) return 'cloud'
  if (input.principal === 'org-member' || input.principal === 'guest') return 'shared'
  return 'own'
}

/** A cloud machine is grouped by its organization, a shared host by its owner. */
function groupOf(zone: FleetMachine['zone'], input: FleetMachineInput): string | null {
  if (zone === 'cloud') return input.organizationName ?? null
  if (zone === 'shared') return input.ownerName ?? input.organizationName ?? null
  return null
}

/**
 * The lifecycle of managed compute wins over the connection: a stopped machine is
 * stopped, not unreachable. Otherwise the connection says it, and a host that
 * answers is running when sessions work on it. A cloud machine that its operator
 * runs has no lifecycle, so the connection says its state.
 */
export function fleetStateOf(readiness: HostReadiness, managedState: ManagedHostLifecycle | undefined, sessions: number): FleetState {
  if (managedState === 'stopped' || managedState === 'stopping' || managedState === 'deleting') return 'stopped'
  if (managedState === 'provisioning' || managedState === 'starting') return 'starting'
  if (managedState === 'failed') return 'unreachable'
  if (readiness === 'ready') return sessions > 0 ? 'running' : 'idle'
  if (readiness === 'checking') return 'checking'
  if (readiness === 'reconnecting') return 'reconnecting'
  return 'unreachable'
}

export function toneOf(state: FleetState): FleetTone {
  if (state === 'running' || state === 'idle') return 'ok'
  if (state === 'unreachable') return 'bad'
  if (state === 'stopped') return 'off'
  return 'warn'
}

/** A host that wants the person: a problem, a missing sign-in, or an update. */
export function needsAttention(machine: FleetMachine): boolean {
  return machine.state === 'unreachable' || machine.state === 'reconnecting' || machine.needsSetup || machine.hasUpdate
}

/* ---------- zones ---------- */

export interface Point { x: number; y: number }

export interface FleetZone {
  id: FleetZoneId
  label: string
  /** Its links go through the Solus tunnel, so it sits past the tunnel. The other zones sit before this device. */
  isViaTunnel: boolean
  /** How many hosts show as cards; past this, the zone shows tiles. */
  cardCapacity: number
}

/** The zones of each side stack in this order. */
export const ZONES: readonly FleetZone[] = [
  { id: 'own', label: 'Your machines', isViaTunnel: false, cardCapacity: 5 },
  { id: 'cloud', label: 'Solus Cloud', isViaTunnel: true, cardCapacity: 3 },
  { id: 'shared', label: 'Shared with you', isViaTunnel: true, cardCapacity: 1 },
]

/**
 * Whether each zone's hosts are read yet (plans/033 §3 Q2): your machines come
 * from the person's host list, Solus Cloud and Shared with you from the account
 * directory. Nothing is kept from an earlier start, so a zone says it is reading,
 * or that its read failed, until one answers.
 */
export type ZoneAnswers = Record<FleetZoneId, AnswerState>

export const ZONES_ANSWERED = { own: 'ready', cloud: 'ready', shared: 'ready' } satisfies ZoneAnswers

/** The hosts of each zone, in the order the fleet lists them. */
export interface MachinesByZone {
  own: FleetMachine[]
  cloud: FleetMachine[]
  shared: FleetMachine[]
}

export function machinesByZone(machines: readonly FleetMachine[]): MachinesByZone {
  const byZone: MachinesByZone = { own: [], cloud: [], shared: [] }
  for (const machine of machines) if (machine.zone !== 'device') byZone[machine.zone].push(machine)
  return byZone
}

export function isZoneFull(zone: FleetZone, count: number): boolean {
  return count > zone.cardCapacity
}

/** The hosts of a zone by group, in the order the groups first appear. */
export function groupsOf(machines: readonly FleetMachine[]): Array<{ group: string | null; machines: FleetMachine[] }> {
  const groups = new Map<string | null, FleetMachine[]>()
  for (const machine of machines) {
    const list = groups.get(machine.group)
    if (list) list.push(machine)
    else groups.set(machine.group, [machine])
  }
  return [...groups].map(([group, list]) => ({ group, machines: list }))
}

/* ---------- totals ---------- */

export interface FleetRollup {
  total: number
  answering: number
  reconnecting: number
  unreachable: number
  stopped: number
  sessions: number
  /** The median latency of the hosts that answer; null when none has one. */
  medianLatencyMs: number | null
  averageCpu: number | null
}

export function rollup(machines: readonly FleetMachine[]): FleetRollup {
  const answering = machines.filter((machine) => machine.state === 'running' || machine.state === 'idle')
  const latencies = answering.flatMap((machine) => machine.latencyMs === null ? [] : [machine.latencyMs]).sort((a, b) => a - b)
  const cpus = answering.flatMap((machine) => machine.cpu === null ? [] : [machine.cpu])
  return {
    total: machines.length,
    answering: answering.length,
    reconnecting: machines.filter((machine) => machine.state === 'reconnecting' || machine.state === 'checking' || machine.state === 'starting').length,
    unreachable: machines.filter((machine) => machine.state === 'unreachable').length,
    stopped: machines.filter((machine) => machine.state === 'stopped').length,
    sessions: machines.reduce((sum, machine) => sum + machine.sessions, 0),
    medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
    averageCpu: cpus.length ? Math.round(cpus.reduce((sum, cpu) => sum + cpu, 0) / cpus.length) : null,
  }
}

/* ---------- the map ---------- */

/**
 * The map's geometry, in rem. Down, the map has one height and its rows have
 * fixed heights. Across, a zone and this device take a share of a narrow map and
 * no more than a fixed width of a wide one, so a wider map gives its room to the
 * links. Each answer is a percent of the map box.
 */
export const MAP_HEIGHT = 26
export const ZONE_HEADER = 2.125
export const CARD_HEIGHT = 3.25
const CARD_GAP = 0.375
const ZONE_FOOT = 0.5
const ZONE_GAP = 0.625
const MAP_MARGIN = 1
const ZONE_INSET = 0.5
const ZONE_WIDTH = { share: 26.5, most: 15 }
const HUB_WIDTH = { share: 24, most: 13.5 }
/** How the room between the zones and this device divides: the links before this device, the link to the tunnel, and the links past it. */
const LINK_ROOM = { beforeDevice: 0.4, toTunnel: 0.18 }
/** The width the map has before it is measured: the reading column of Settings. */
const UNMEASURED_MAP_WIDTH = 48

/** A zone's place on the map, in percent of the map box. */
export interface ZoneBox { x: number; y: number; w: number; h: number }

/**
 * What one row of a zone with room shows: a host, a found machine to add, a way to
 * add one, that the zone has nothing, that its hosts are not read yet, or, in a
 * zone opened in place, how many more hosts the zone's own page lists.
 */
export type ZoneSlot =
  | { kind: 'host'; machine: FleetMachine }
  | { kind: 'found'; machine: FoundMachine }
  | { kind: 'add'; way: Extract<AddWay, 'cloud' | 'pair'> }
  | { kind: 'empty' }
  | { kind: 'unread'; state: Exclude<AnswerState, 'ready'> }
  | { kind: 'more'; count: number }

/** A zone opened in place shows this many cards; its page lists the rest. */
export const OPEN_ZONE_CARDS = 40

export interface ZoneRow {
  slot: ZoneSlot
  /** The center of the row's card. */
  at: Point
  /** Where a link to the card ends: the middle of the card's edge that faces this device. */
  port: Point
}

export interface ZoneLayout {
  zone: FleetZone
  hosts: FleetMachine[]
  /** More hosts than cards fit: the zone shows tiles and one link. */
  isFull: boolean
  /** More hosts than cards fit, and the person opened it in place: it shows a card for each, and can fold again. */
  isOpen: boolean
  /** The rows of a zone with room, its hosts first; none when it is full. */
  rows: ZoneRow[]
  /** The found machines that would join the zone and have no row in it. */
  moreFound: number
  box: ZoneBox
  /** Where the zone's links start: the edge of this device, or the tunnel. */
  linkStart: Point
  /** Where the one link of a full zone ends: the middle of the zone's edge that faces this device. */
  port: Point
}

export interface MapLayout {
  /** The map's height in rem: `MAP_HEIGHT`, or more when a side's zones need it. */
  height: number
  zones: ZoneLayout[]
  /** The lanes of the lines between your hosts, on the outer side of Your machines: the x of the lane nearest the cards, and the step outward, in percent. */
  lanes: { first: number; step: number }
  /** This device, at the map's center: its center and its width. */
  hub: Point & { w: number }
  /** The Solus tunnel, between this device and the zones past it. */
  tunnel: Point
  cardWidth: number
  /** The space between a zone's edge and its cards. */
  zoneInset: number
}

/**
 * The rows of a zone with room: its hosts, then room to grow, which is a found
 * machine where it would go or a way to add one. A zone always has a row, so an
 * empty zone says what it is for. A zone whose hosts are not read yet says so in
 * place of room to grow: what it would offer depends on the answer.
 */
function zoneSlots(zone: FleetZone, hosts: readonly FleetMachine[], found: readonly FoundMachine[], answer: AnswerState): ZoneSlot[] {
  const slots: ZoneSlot[] = hosts.slice(0, OPEN_ZONE_CARDS).map((machine) => ({ kind: 'host', machine }))
  if (hosts.length > OPEN_ZONE_CARDS) return [...slots, { kind: 'more', count: hosts.length - OPEN_ZONE_CARDS }]
  if (answer !== 'ready') return [...slots, { kind: 'unread', state: answer }]
  for (const machine of found.filter((machine) => machine.zone === zone.id).slice(0, Math.max(0, zone.cardCapacity - slots.length))) {
    slots.push({ kind: 'found', machine })
  }
  if (zone.id === 'cloud' && slots.length < zone.cardCapacity) slots.push({ kind: 'add', way: 'cloud' })
  if (slots.length === 0) {
    slots.push(zone.id === 'own' ? { kind: 'add', way: 'pair' } : { kind: 'empty' })
  }
  return slots
}

/** The space between two lanes of the lines between your hosts. */
export const REACH_LANE_PITCH = 0.625

export interface MapLayoutOptions {
  /** The zones the person opened in place: a card for each host, however many. */
  open?: ReadonlySet<FleetZoneId>
  /** The lanes the lines between your hosts need, on the outer side of Your machines. */
  reachLanes?: number
}

/**
 * Where everything on the map sits, for a map `mapWidth` rem wide; 0 before it is
 * measured. A zone is as tall as its rows, or as its capacity when it shows
 * tiles. The zones of a side stack, and each stack is centered on this device, so
 * the links spread evenly above and below it. A side taller than `MAP_HEIGHT` (a
 * zone opened in place) makes the map taller; the frame fits or pans it.
 */
export function mapLayout(byZone: MachinesByZone, found: readonly FoundMachine[], mapWidth: number, answers: ZoneAnswers = ZONES_ANSWERED, options: MapLayoutOptions = {}): MapLayout {
  const across = (rem: number) => (rem / (mapWidth > 0 ? mapWidth : UNMEASURED_MAP_WIDTH)) * 100
  const zoneWidth = Math.min(ZONE_WIDTH.share, across(ZONE_WIDTH.most))
  const hubWidth = Math.min(HUB_WIDTH.share, across(HUB_WIDTH.most))
  const margin = across(MAP_MARGIN)
  // The lanes take room from the links, not from the zones.
  const laneRoom = across((options.reachLanes ?? 0) * REACH_LANE_PITCH)
  const zoneInset = across(ZONE_INSET)
  const linkRoom = 100 - 2 * margin - laneRoom - 2 * zoneWidth - hubWidth
  const ownLeft = margin + laneRoom
  const hubLeft = ownLeft + zoneWidth + linkRoom * LINK_ROOM.beforeDevice
  const tunnel = { x: hubLeft + hubWidth + linkRoom * LINK_ROOM.toTunnel, y: 50 }

  const stacked = ZONES.map((zone) => {
    const hosts = byZone[zone.id]
    const isOpen = isZoneFull(zone, hosts.length) && !!options.open?.has(zone.id)
    const isFull = isZoneFull(zone, hosts.length) && !isOpen
    const slots = isFull ? [] : zoneSlots(zone, hosts, found, answers[zone.id])
    const rowCount = isFull ? zone.cardCapacity : slots.length
    const moreFound = found.filter((machine) => machine.zone === zone.id).length - slots.filter((slot) => slot.kind === 'found').length
    return { zone, hosts, isFull, isOpen, slots, moreFound, height: ZONE_HEADER + rowCount * CARD_HEIGHT + (rowCount - 1) * CARD_GAP + ZONE_FOOT }
  })
  const heightOf = (zones: typeof stacked) => zones.reduce((sum, other) => sum + other.height, 0)
  const sideHeight = (isViaTunnel: boolean) => {
    const stack = stacked.filter((other) => other.zone.isViaTunnel === isViaTunnel)
    return heightOf(stack) + (stack.length - 1) * ZONE_GAP
  }
  const height = Math.max(MAP_HEIGHT, sideHeight(false) + 2 * MAP_MARGIN, sideHeight(true) + 2 * MAP_MARGIN)
  const down = (rem: number) => (rem / height) * 100
  const hub = { x: hubLeft + hubWidth / 2, y: 50, w: hubWidth }

  const zones = stacked.map(({ zone, hosts, isFull, isOpen, slots, moreFound, height: zoneHeight }) => {
    const stack = stacked.filter((other) => other.zone.isViaTunnel === zone.isViaTunnel)
    const above = stack.slice(0, stack.findIndex((other) => other.zone.id === zone.id))
    const top = (height - sideHeight(zone.isViaTunnel)) / 2 + heightOf(above) + above.length * ZONE_GAP
    const x = zone.isViaTunnel ? 100 - margin - zoneWidth : ownLeft
    const facingEdge = zone.isViaTunnel ? x : x + zoneWidth
    const rows = slots.map((slot, index) => {
      const y = down(top + ZONE_HEADER + index * (CARD_HEIGHT + CARD_GAP) + CARD_HEIGHT / 2)
      return { slot, at: { x: x + zoneWidth / 2, y }, port: { x: zone.isViaTunnel ? facingEdge + zoneInset : facingEdge - zoneInset, y } }
    })
    return {
      zone,
      hosts,
      isFull,
      isOpen,
      rows,
      moreFound,
      box: { x, y: down(top), w: zoneWidth, h: down(zoneHeight) },
      linkStart: zone.isViaTunnel ? tunnel : { x: hubLeft, y: hub.y },
      port: { x: facingEdge, y: down(top + zoneHeight / 2) },
    }
  })
  return {
    height,
    zones,
    hub,
    tunnel,
    cardWidth: zoneWidth - 2 * zoneInset,
    zoneInset,
    lanes: { first: ownLeft - across(REACH_LANE_PITCH) / 2, step: -across(REACH_LANE_PITCH) },
  }
}

/* ---------- links ---------- */

export function linkPath(from: Point, to: Point): string {
  const middle = (from.x + to.x) / 2
  return `M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`
}

/** How long the light takes along a link that carries sessions: busier is faster, never quick enough to pull the eye. */
export function travelSeconds(sessions: number): number {
  return Math.max(3.5, 8 - Math.log2(sessions + 1) * 0.7)
}

/* ---------- tiles ---------- */

export type TileColorMode = 'status' | 'cpu' | 'sessions'

/**
 * A tile's fill as a CSS color, from the Solus status tokens. Healthy hosts are
 * green when idle and terracotta when running; a problem takes its own color in
 * every mode, and a stopped host is an outline (`null`).
 */
export function tileFill(machine: FleetMachine, mode: TileColorMode): string | null {
  const tone = toneOf(machine.state)
  if (tone === 'off') return null
  if (tone === 'warn') return 'var(--warning)'
  if (tone === 'bad') return 'var(--solus-status-error)'
  if (mode === 'status') return machine.sessions ? mix('var(--solus-status-running)', 35 + Math.min(machine.sessions, 5) * 12) : mix('var(--success)', 80)
  if (mode === 'cpu') {
    const cpu = machine.cpu ?? 0
    if (cpu < 60) return mix('var(--success)', 45 + cpu * 0.9)
    if (cpu < 80) return mix('var(--warning)', 55 + (cpu - 60) * 2)
    return 'var(--solus-status-error)'
  }
  return machine.sessions ? mix('var(--solus-status-running)', 22 + Math.min(machine.sessions, 5) * 15) : 'var(--wash-3)'
}

function mix(color: string, percent: number): string {
  return `color-mix(in oklch, ${color} ${Math.round(percent)}%, transparent)`
}

/* ---------- adding a machine ---------- */

export type AddWay = 'nearby' | 'cloud' | 'pair' | 'ssh'

/** Whether a host matches what the person typed in Find: its name, its group, or its system. */
export function machineMatches(machine: FleetMachine, query: string): boolean {
  const typed = query.trim().toLowerCase()
  if (!typed) return true
  return [machine.label, machine.group ?? '', machine.os ?? ''].some((text) => text.toLowerCase().includes(typed))
}

const ROUTE_NAMES = {
  lan: 'Local network',
  tailnet: 'Tailscale',
  vpn: 'VPN',
  public: 'Internet',
  tunnel: 'Solus tunnel',
  forwarded: 'SSH forward',
} satisfies Record<RouteKind, string>

/** The words of a host's route mark: "Tailscale: in use", "Local network: connecting". */
export function routeInUseLabel(route: RouteInUse): string {
  const phase = route.phase === 'in-use' ? 'in use' : route.phase === 'connecting' ? 'connecting' : 'sign-in refused'
  return `${ROUTE_NAMES[route.kind]}: ${phase}`
}

/** How this device reaches a host, hop by hop: the line the map footer and the host page draw. */
export function routeHops(machine: FleetMachine): string[] {
  if (machine.isThisDevice) return ['This device']
  // Only the route the link is on, or tries: a saved route it does not dial is not how it reaches the host.
  const route = machine.routeInUse ? ROUTE_NAMES[machine.routeInUse.kind] : 'Not connected'
  return ['This device', route, ...(machine.group ? [machine.group] : []), machine.label]
}

export type AttentionKind = 'unreachable' | 'reconnecting' | 'signin' | 'update'

/** The most urgent problem of a host; null when it wants nothing. */
export function attentionKindOf(machine: FleetMachine): AttentionKind | null {
  return machine.state === 'unreachable' ? 'unreachable'
    : machine.state === 'reconnecting' ? 'reconnecting'
      : machine.needsSetup ? 'signin'
        : machine.hasUpdate ? 'update'
          : null
}

export interface AttentionRow {
  kind: AttentionKind
  /** One host's name, or how many hosts the row stands for. */
  title: string
  /** What is wrong, or the first names of the hosts the row stands for. */
  note: string
  serverIds: string[]
  /** The fix of a host that does not answer: retry, start, or pair again (`hostReadinessCopy`). Rows of several hosts retry. */
  fix: HostReadinessAction | null
}

const ATTENTION_NOTE = {
  unreachable: 'Solus cannot reach it',
  reconnecting: 'Reconnecting',
  signin: 'An agent needs a sign-in',
  update: 'An update is ready',
} satisfies Record<AttentionKind, string>

/**
 * The "Needs attention" list: one row for each host while there are a handful,
 * and one row for each kind of problem when there are more, so a large fleet
 * stays four rows long. A host is listed once, for its most urgent problem.
 */
export function attentionRows(machines: readonly FleetMachine[], maxSingleRows = 5): AttentionRow[] {
  const listed = machines.flatMap((machine) => {
    const kind = attentionKindOf(machine)
    return kind ? [{ machine, kind }] : []
  })
  if (listed.length <= maxSingleRows) {
    return listed.map(({ machine, kind }) => ({
      kind,
      title: machine.label,
      // A host that does not answer says why in the words every client uses: "Needs pairing", "Not running".
      note: kind === 'unreachable' && machine.problem ? machine.problem.label : ATTENTION_NOTE[kind],
      serverIds: [machine.serverId],
      fix: kind === 'unreachable' ? machine.problem?.action ?? 'retry' : null,
    }))
  }
  const order: AttentionKind[] = ['unreachable', 'reconnecting', 'signin', 'update']
  return order.flatMap((kind) => {
    const hosts = listed.filter((entry) => entry.kind === kind).map((entry) => entry.machine)
    if (!hosts.length) return []
    const names = hosts.slice(0, 3).map((machine) => machine.label).join(', ')
    return [{
      kind,
      title: `${hosts.length} ${hosts.length === 1 ? 'host' : 'hosts'}`,
      note: hosts.length > 3 ? `${names}, and ${hosts.length - 3} more` : names,
      serverIds: hosts.map((machine) => machine.serverId),
      fix: kind === 'unreachable' ? 'retry' : null,
    }]
  })
}

/** What kind of host this is, in a few words, for the host page header. */
export function hostKindLabel(machine: FleetMachine): string {
  if (machine.zone === 'device') return 'This device'
  if (machine.zone === 'cloud') return machine.group ? `Solus Cloud · ${machine.group}` : 'Solus Cloud'
  if (machine.zone === 'shared') return machine.group ? `Shared by ${machine.group}` : 'Shared with you'
  if (machine.routeKind === 'forwarded') return 'SSH or WSL'
  return machine.routeKind ? ROUTE_NAMES[machine.routeKind] : 'Your machine'
}

/** A line through CPU readings for a 100 × 24 box: the newest on the right. Null with fewer than two readings. */
export function sparklinePath(values: readonly number[]): string | null {
  if (values.length < 2) return null
  return values.map((value, index) => `${index ? 'L' : 'M'} ${(index / (values.length - 1)) * 100} ${(22 - (value / 100) * 20).toFixed(2)}`).join(' ')
}

/* ---------- traffic on the lines ---------- */

/** The total KB/s of these hosts' connections, both ways. */
export function trafficOf(machines: readonly FleetMachine[]): number {
  return machines.reduce((sum, machine) => sum + (machine.traffic ? machine.traffic.down + machine.traffic.up : 0), 0)
}

/** A line is as wide as its traffic: 1.25 px when quiet, up to 5.5 px when busy. Log scale, so one busy host does not hide the rest. */
export function trafficWidth(kilobytesPerSecond: number): number {
  return 1.25 + Math.min(4.25, Math.log2(1 + kilobytesPerSecond / 4) * 0.85)
}

/** "↓ 42 KB/s ↑ 3 KB/s", or that the connection is quiet; null before two reads. */
export function trafficText(traffic: Traffic | null): string | null {
  if (!traffic) return null
  if (traffic.down + traffic.up < 0.1) return 'no traffic'
  return `↓ ${traffic.down} KB/s ↑ ${traffic.up} KB/s`
}

/* ---------- the busiest hosts and the status line ---------- */

export type LoadMeasure = 'cpu' | 'memory'
export type LoadLevel = 'low' | 'medium' | 'high'

/** The standard levels: low under 60%, medium under 80%, high from 80%. */
export function loadLevel(value: number): LoadLevel {
  return value >= 80 ? 'high' : value >= 60 ? 'medium' : 'low'
}

/** The higher of a host's CPU and memory: how busy it is. */
function busiestReading(machine: FleetMachine): number {
  return Math.max(machine.cpu ?? 0, machine.memory ?? 0)
}

/** Every host that answers with a reading, the busiest first: by the higher of its CPU and memory. */
export function busiestHosts(machines: readonly FleetMachine[]): FleetMachine[] {
  return machines
    .filter((machine) => toneOf(machine.state) === 'ok' && (machine.cpu !== null || machine.memory !== null))
    .sort((a, b) => busiestReading(b) - busiestReading(a))
}

/** The middle reading of `measure` among these hosts; null when none has one. */
export function typicalLoad(machines: readonly FleetMachine[], measure: LoadMeasure): number | null {
  const readings = machines.flatMap((machine) => (machine[measure] === null ? [] : [machine[measure]])).sort((a, b) => a - b)
  return readings.length ? readings[Math.floor(readings.length / 2)]! : null
}

/** A host's dot in the load plot: its readings, its size, and whether it is named on the plot. */
export interface LoadPoint {
  machine: FleetMachine
  cpu: number
  memory: number
  /** In px: bigger for more sessions, small when idle. */
  radius: number
  isNamed: boolean
  /** "cloud-26 · CPU 94% · memory 3% · idle": the dot's tooltip and accessible name. */
  label: string
}

/** How many of the busiest hosts are named on the plot. */
const NAMED_POINTS = 4

/** The dots of the load plot: every host that answers with both readings. The busiest are named. */
export function loadPoints(machines: readonly FleetMachine[]): LoadPoint[] {
  const ranked = busiestHosts(machines).filter((machine) => machine.cpu !== null && machine.memory !== null)
  return ranked.map((machine, index) => ({
    machine,
    cpu: machine.cpu!,
    memory: machine.memory!,
    radius: machine.sessions ? 4 + Math.min(machine.sessions, 4) : 3.5,
    isNamed: index < NAMED_POINTS,
    label: `${machine.label} · CPU ${machine.cpu}% · memory ${machine.memory}% · ${machine.sessions ? `${machine.sessions} ${machine.sessions === 1 ? 'session' : 'sessions'}` : 'idle'}`,
  }))
}

/** How many hosts are high on either reading. */
export function highCount(points: readonly LoadPoint[]): number {
  return points.filter((point) => loadLevel(Math.max(point.cpu, point.memory)) === 'high').length
}

/** One icon of the status line: a state with its count, and its words for the tooltip. */
export interface StatusItem {
  key: string
  state: 'reconnecting' | 'stopped' | 'unreachable' | 'signin' | 'update'
  label: string
  count: number
}

export interface StatusLine {
  online: number
  total: number
  items: StatusItem[]
}

/**
 * The status of the fleet on one line: how many hosts answer, then each
 * other state as an icon with its count, worst first. A host that does not
 * answer is counted by its readiness words ("Needs pairing", "Offline").
 */
export function statusLine(machines: readonly FleetMachine[]): StatusLine {
  const items = new Map<string, StatusItem>()
  const add = (key: string, state: StatusItem['state'], label: string) => {
    const item = items.get(key) ?? { key, state, label, count: 0 }
    item.count++
    items.set(key, item)
  }
  let online = 0
  for (const machine of machines) {
    const tone = toneOf(machine.state)
    if (tone === 'ok') online++
    else if (tone === 'off') add('stopped', 'stopped', 'Stopped')
    else if (tone === 'warn') add('reconnecting', 'reconnecting', 'Reconnecting')
    else if (machine.problem?.action === 'pair-again') add(`bad:${machine.problem.label}`, 'signin', machine.problem.label)
    else add(`bad:${machine.problem?.label ?? 'Unreachable'}`, 'unreachable', machine.problem?.label ?? 'Unreachable')
    if (machine.needsSetup) add('signin', 'signin', 'Needs an agent sign-in')
    if (machine.hasUpdate) add('update', 'update', 'Update available')
  }
  const order = { unreachable: 0, signin: 1, reconnecting: 2, stopped: 3, update: 4 } satisfies Record<StatusItem['state'], number>
  return { online, total: machines.length, items: [...items.values()].sort((a, b) => order[a.state] - order[b.state] || b.count - a.count) }
}
