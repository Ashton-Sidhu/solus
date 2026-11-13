import type { HostReadiness } from '@solus/client-core/host-readiness'
import type { RouteKind } from '@solus/contracts/host-routes'
import type { HostOperatingSystem } from '@solus/contracts/types'
import type { ManagedHostLifecycle } from '@solus/contracts/uplink'

/**
 * The fleet view's model (docs/plans/host-fleet.md D3, D4): every host as one
 * `FleetMachine`, the zone its route puts it in, its state, and the numbers the
 * map and the summary show. Pure, so the map, the summary, and the tests read the
 * same answers.
 */

/** A zone is how this device reaches its hosts. `device` is this device itself, at the map's center. */
export type FleetZoneId = 'own' | 'forwarded' | 'cloud' | 'shared'

/** What a host is doing now, as one icon shows it (D3). */
export type FleetState = 'running' | 'idle' | 'checking' | 'starting' | 'reconnecting' | 'unreachable' | 'stopped'

/** The four colors the map uses. Healthy is green; only a problem gets amber or red. */
export type FleetTone = 'ok' | 'warn' | 'bad' | 'off'

export interface FleetMachine {
  serverId: string
  label: string
  os?: HostOperatingSystem
  /** A Solus Cloud machine: its mark is the cloud, and it can start, stop, and resize. */
  isManaged: boolean
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
  /** The kind of the route this device dials the host on. */
  routeKind: RouteKind | null
  hasUpdate: boolean
  needsSetup: boolean
}

export interface FleetMachineInput {
  serverId: string
  label: string
  os?: HostOperatingSystem
  isThisDevice: boolean
  isManaged: boolean
  /** How this client is admitted there: a member or guest uses a host someone else shares. */
  principal?: 'local-owner' | 'remote-owner' | 'org-member' | 'guest' | 'runner' | 'system'
  ownerName?: string
  organizationName?: string
  readiness: HostReadiness
  managedState?: ManagedHostLifecycle
  routeKind: RouteKind | null
  sessions: number
  load: { cpu: number | null; memory: number | null; latencyMs: number | null } | null
  hasUpdate: boolean
  needsSetup: boolean
}

export function fleetMachine(input: FleetMachineInput): FleetMachine {
  const state = fleetStateOf(input.readiness, input.managedState, input.sessions)
  const zone = zoneOf(input)
  const isAnswering = state === 'running' || state === 'idle'
  return {
    serverId: input.serverId,
    label: input.label,
    os: input.os,
    isManaged: input.isManaged,
    isThisDevice: input.isThisDevice,
    zone,
    group: groupOf(zone, input),
    state,
    sessions: isAnswering ? input.sessions : 0,
    cpu: isAnswering ? input.load?.cpu ?? null : null,
    memory: isAnswering ? input.load?.memory ?? null : null,
    latencyMs: isAnswering && !input.isThisDevice ? input.load?.latencyMs ?? null : null,
    routeKind: input.routeKind,
    hasUpdate: input.hasUpdate,
    needsSetup: input.needsSetup,
  }
}

/** The route decides the zone; a cloud machine and a host someone else shares have their own. */
function zoneOf(input: FleetMachineInput): FleetMachine['zone'] {
  if (input.isThisDevice) return 'device'
  if (input.isManaged) return 'cloud'
  if (input.principal === 'org-member' || input.principal === 'guest') return 'shared'
  return input.routeKind === 'forwarded' ? 'forwarded' : 'own'
}

/** A cloud machine is grouped by its organization, a shared host by its owner. */
function groupOf(zone: FleetMachine['zone'], input: FleetMachineInput): string | null {
  if (zone === 'cloud') return input.organizationName ?? null
  if (zone === 'shared') return input.ownerName ?? input.organizationName ?? null
  return null
}

/**
 * A Solus Cloud machine's lifecycle wins over the connection: a stopped machine is
 * stopped, not unreachable. Otherwise the connection says it, and a host that
 * answers is running when sessions work on it.
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
  /** Where the zone sits on the map, in percent of the map box. */
  x: number; y: number; w: number; h: number
  /** Where a zone's one link ends when it shows tiles. */
  anchor: Point
  /** Its links go through the Solus tunnel. */
  isViaTunnel: boolean
  /** How many hosts show as cards; past this, the zone shows tiles. */
  cardCapacity: number
}

export const ZONES: readonly FleetZone[] = [
  { id: 'own', label: 'Your machines', x: 1.5, y: 3, w: 30, h: 94, anchor: { x: 31.5, y: 50 }, isViaTunnel: false, cardCapacity: 4 },
  { id: 'forwarded', label: 'SSH and WSL', x: 34, y: 70, w: 24, h: 27, anchor: { x: 46, y: 70 }, isViaTunnel: false, cardCapacity: 1 },
  { id: 'cloud', label: 'Solus Cloud', x: 67, y: 3, w: 31.5, h: 55, anchor: { x: 67, y: 22 }, isViaTunnel: true, cardCapacity: 3 },
  { id: 'shared', label: 'Shared with you', x: 67, y: 62, w: 31.5, h: 35, anchor: { x: 67, y: 80 }, isViaTunnel: true, cardCapacity: 1 },
]

/** This device, at the map's center. */
export const HUB: Point = { x: 46, y: 36 }
/** The Solus tunnel, between this device and the cloud and shared zones. */
export const TUNNEL: Point = { x: 62, y: 36 }

/** The hosts of each zone, in the order the fleet lists them. */
export interface MachinesByZone {
  own: FleetMachine[]
  forwarded: FleetMachine[]
  cloud: FleetMachine[]
  shared: FleetMachine[]
}

export function machinesByZone(machines: readonly FleetMachine[]): MachinesByZone {
  const byZone: MachinesByZone = { own: [], forwarded: [], cloud: [], shared: [] }
  for (const machine of machines) if (machine.zone !== 'device') byZone[machine.zone].push(machine)
  return byZone
}

export function isZoneFull(zone: FleetZone, count: number): boolean {
  return count > zone.cardCapacity
}

/** Where the `index`th card of a zone sits, for a zone with room for cards. */
export function cardPosition(zone: FleetZoneId, index: number): Point {
  if (zone === 'own') return { x: 16.5, y: 22 + index * 19 }
  if (zone === 'forwarded') return { x: 46, y: 86 }
  if (zone === 'cloud') return { x: 82.75, y: 21 + index * 13 }
  return { x: 82.75, y: 81 }
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

/** A zone's one link turns amber when more than a tenth of its hosts are down. */
export function isZoneTroubled(summary: FleetRollup): boolean {
  return summary.total > 0 && (summary.unreachable + summary.reconnecting) / summary.total > 0.1
}

/* ---------- links ---------- */

export function linkPath(from: Point, to: Point): string {
  const middle = (from.x + to.x) / 2
  return `M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`
}

/** How long the light takes along a link that carries sessions: busier is faster, never quick enough to pull the eye (D5). */
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

export type AddWay = 'nearby' | 'cloud' | 'link' | 'pair' | 'ssh'

/**
 * The one way the Add page recommends (D8): a machine already in reach is the
 * fastest add; with none, a cloud machine needs no setup; without an
 * organization to create one in, linking your own machine is next.
 */
export function recommendedAddWay(foundCount: number, canCreateCloudMachine: boolean): AddWay {
  if (foundCount > 0) return 'nearby'
  return canCreateCloudMachine ? 'cloud' : 'link'
}

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

/** How this device reaches a host, hop by hop: the line the map footer and the host page draw. */
export function routeHops(machine: FleetMachine): string[] {
  if (machine.isThisDevice) return ['This device']
  const route = machine.routeKind ? ROUTE_NAMES[machine.routeKind] : 'Not reached yet'
  return ['This device', route, ...(machine.group ? [machine.group] : []), machine.label]
}

export type AttentionKind = 'unreachable' | 'reconnecting' | 'signin' | 'update'

export interface AttentionRow {
  kind: AttentionKind
  /** One host's name, or how many hosts the row stands for. */
  title: string
  /** What is wrong, or the first names of the hosts the row stands for. */
  note: string
  serverIds: string[]
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
  const kindOf = (machine: FleetMachine): AttentionKind | null =>
    machine.state === 'unreachable' ? 'unreachable'
      : machine.state === 'reconnecting' ? 'reconnecting'
        : machine.needsSetup ? 'signin'
          : machine.hasUpdate ? 'update'
            : null
  const listed = machines.flatMap((machine) => {
    const kind = kindOf(machine)
    return kind ? [{ machine, kind }] : []
  })
  if (listed.length <= maxSingleRows) {
    return listed.map(({ machine, kind }) => ({ kind, title: machine.label, note: ATTENTION_NOTE[kind], serverIds: [machine.serverId] }))
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
    }]
  })
}

/** What kind of host this is, in a few words, for the host page header. */
export function hostKindLabel(machine: FleetMachine): string {
  if (machine.zone === 'device') return 'This device'
  if (machine.zone === 'cloud') return machine.group ? `Solus Cloud · ${machine.group}` : 'Solus Cloud'
  if (machine.zone === 'shared') return machine.group ? `Shared by ${machine.group}` : 'Shared with you'
  if (machine.zone === 'forwarded') return 'SSH or WSL'
  return machine.routeKind ? ROUTE_NAMES[machine.routeKind] : 'Your machine'
}

/** A line through CPU readings for a 100 × 24 box: the newest on the right. Null with fewer than two readings. */
export function sparklinePath(values: readonly number[]): string | null {
  if (values.length < 2) return null
  return values.map((value, index) => `${index ? 'L' : 'M'} ${(index / (values.length - 1)) * 100} ${(22 - (value / 100) * 20).toFixed(2)}`).join(' ')
}
