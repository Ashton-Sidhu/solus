import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostLinkHealth, HostPairing, HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import { type HostRoute, carriesTokenInClear, routeForUrl } from '@solus/contracts/host-routes'
import { permissionsAllow } from '@solus/contracts/permissions'
import type { HostApi } from './host-api'
import { lastSeenText } from './host-readiness'

export interface LinkMachine {
  label: string
  info: Pick<ConnectionsServerInfo, 'installationId' | 'identityKey' | 'routes' | 'principal' | 'permissions' | 'remoteAccess' | 'hostKind'>
  api: Pick<HostApi, 'hostsPair' | 'hostsPairClient' | 'hostsUnlink' | 'connectionsGeneratePairToken' | 'hostsLinkHealth'>
  snapshot: HostPairingsSnapshot | null
  isCurrent(): boolean
}

export interface LinkChoice {
  id: string
  label: string
  route: HostRoute
  identityKey: string
  viaLabel?: string
  mint(): Promise<string>
}

export function canManageMachineLinks(info: Pick<ConnectionsServerInfo, 'principal' | 'permissions'>): boolean {
  return info.principal === 'local-owner' && permissionsAllow(info.permissions, 'host.local.reach')
}

function machineRoute(route: HostRoute): boolean {
  if (route.kind === 'forwarded' || route.kind === 'tunnel') return false
  try {
    const url = new URL(route.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== route.url) return false
    if (/^(localhost|.*\.localhost|127\..*|\[::1\]|0\.0\.0\.0|\[::\])$/i.test(url.hostname)) return false
  } catch {
    return false
  }
  const pairingRoute = routeForUrl(route.url)
  return pairingRoute.kind === 'lan' || !carriesTokenInClear(pairingRoute)
}

export function pairedHostRoute(pairing: HostPairing): HostRoute | undefined {
  return pairing.url ? routeForUrl(pairing.url) : pairing.listing.routes[0]
}

/** Prefer an owner connection to the target. Otherwise use a separate owner
 * pairing held by a known machine. Each link still pairs with the target. */
export function machineLinkChoices(source: LinkMachine, machines: readonly LinkMachine[]): LinkChoice[] {
  if (!source.snapshot || !canManageMachineLinks(source.info)) return []
  const blocked = new Set(source.snapshot.hosts.map(({ listing }) => listing.installationId))
  blocked.add(source.info.installationId)
  const choices = new Map<string, LinkChoice>()
  for (const machine of machines) {
    const { info } = machine
    if (blocked.has(info.installationId) || !canManageMachineLinks(info) || info.remoteAccess === 'off' || info.hostKind === 'managed' || !info.identityKey) continue
    const route = info.routes.find(machineRoute)
    if (!route) continue
    choices.set(info.installationId, {
      id: info.installationId, label: machine.label, identityKey: info.identityKey, route,
      mint: async () => {
        if (!machine.isCurrent()) throw new Error('The target connection changed.')
        const { token } = await machine.api.connectionsGeneratePairToken()
        if (!machine.isCurrent()) throw new Error('The target connection changed.')
        return token
      },
    })
  }
  for (const machine of machines) {
    if (!canManageMachineLinks(machine.info)) continue
    for (const pairing of machine.snapshot?.hosts ?? []) {
      const { listing } = pairing
      const id = listing.installationId
      const route = pairedHostRoute(pairing)
      if (blocked.has(id) || choices.has(id) || !listing.identityKey || !route || !machineRoute(route)) continue
      choices.set(id, {
        id, label: listing.label, identityKey: listing.identityKey, route, viaLabel: machine.label,
        mint: async () => {
          if (!machine.isCurrent()) throw new Error('The connection to the known machine changed.')
          const credential = await machine.api.hostsPairClient(id, true)
          if (!machine.isCurrent() || credential.url !== route.url || credential.listing.installationId !== id || credential.listing.identityKey !== listing.identityKey) {
            throw new Error('The link to the target changed.')
          }
          return credential.code
        },
      })
    }
  }
  return [...choices.values()]
}

export type MachineLinkOutcome = 'linked' | 'failed'

/** One consent action, with a separate authorization and result for each target. */
export async function linkMachines(source: LinkMachine, choices: readonly LinkChoice[], onResult: (id: string, outcome: MachineLinkOutcome) => void): Promise<void> {
  if (!source.snapshot || !canManageMachineLinks(source.info)) return
  let next = 0
  const worker = async () => {
    for (let index = next++; index < choices.length; index = next++) {
      const choice = choices[index]!
      let outcome: MachineLinkOutcome = 'failed'
      try {
        if (!source.isCurrent()) throw new Error('The source connection changed.')
        const token = await choice.mint()
        if (!source.isCurrent()) throw new Error('The source connection changed.')
        await source.api.hostsPair({
          url: choice.route.url,
          code: `${choice.route.url}/pair#token=${encodeURIComponent(token)}`,
          link: { installationId: choice.id, identityKey: choice.identityKey },
        })
        outcome = 'linked'
      } catch {
        // Transport errors can carry the request, including its one-use secret.
      }
      onResult(choice.id, outcome)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, choices.length) }, worker))
}

/** Asks the client to reach the existing link after a person chooses Connect. */
export async function connectThroughMachine(
  installationId: string,
  sources: readonly { pairAgain(id: string): Promise<boolean> }[],
): Promise<boolean> {
  for (const source of sources) {
    if (await source.pairAgain(installationId)) return true
  }
  return false
}

/* ---------- link health, and the view of every link (docs/host-pairing.md, "Link health") ---------- */

/** A link this close to its expiry says so. */
export const LINK_EXPIRY_WARNING_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** How one machine link reads to a person. `checking` until its health is read; `unknown` when the machine cannot tell. */
export type MachineLinkState =
  | { kind: 'checking' }
  | { kind: 'unknown' }
  | { kind: 'reachable'; expiresInDays: number | null }
  | { kind: 'failing'; detail: string }
  | { kind: 'unreachable'; detail: string | null }
  | { kind: 'expired'; detail: string | null }

export function machineLinkState(health: HostLinkHealth | 'unavailable' | undefined, now: number): MachineLinkState {
  if (!health) return { kind: 'checking' }
  if (health === 'unavailable') return { kind: 'unknown' }
  if (health.status === 'expired') return { kind: 'expired', detail: health.lastError }
  if (health.status === 'unreachable') return { kind: 'unreachable', detail: health.lastError }
  if (health.lastError !== null) return { kind: 'failing', detail: health.lastError }
  const days = health.expiresAt === null ? null : Math.ceil((health.expiresAt - now) / DAY_MS)
  return { kind: 'reachable', expiresInDays: days !== null && days <= LINK_EXPIRY_WARNING_DAYS ? days : null }
}

export type MachineLinkTone = 'ok' | 'warn' | 'bad' | 'unknown'

/** A link that cannot work is `bad`; one that may soon not work is `warn`. */
export function machineLinkTone(state: MachineLinkState): MachineLinkTone {
  switch (state.kind) {
    case 'checking':
    case 'unknown': return 'unknown'
    case 'reachable': return state.expiresInDays === null ? 'ok' : 'warn'
    case 'unreachable': return 'warn'
    case 'failing':
    case 'expired': return 'bad'
  }
}

const TONE_RANK = { bad: 0, warn: 1, unknown: 2, ok: 3 } satisfies Record<MachineLinkTone, number>

/** The state of the two directions of a two-way link that wants more attention. */
export function worseLinkState(left: MachineLinkState, right: MachineLinkState): MachineLinkState {
  return TONE_RANK[machineLinkTone(right)] < TONE_RANK[machineLinkTone(left)] ? right : left
}

/** One word or a few: "Reachable", "Expires in 3 days", "Not answering", "Failing", "Expired". */
export function machineLinkStateText(state: MachineLinkState): string {
  switch (state.kind) {
    case 'checking': return 'Checking'
    case 'unknown': return 'Health unknown'
    case 'reachable':
      return state.expiresInDays === null ? 'Reachable'
        : state.expiresInDays <= 1 ? 'Expires within a day' : `Expires in ${state.expiresInDays} days`
    case 'unreachable': return 'Not answering'
    case 'failing': return 'Failing'
    case 'expired': return 'Expired'
  }
}

/** "Last reached 4 min ago", for the details of a link. */
export function lastReachedText(health: HostLinkHealth, now: number): string {
  return `Last reached ${lastSeenText(health.lastReachedAt, now)}`
}

/** One link between two machines, with the link the other way when there is one. */
export interface MachineLinkView {
  /** `source>target`, by installation id. */
  id: string
  sourceId: string
  sourceLabel: string
  targetId: string
  targetLabel: string
  pairing: HostPairing
  health: HostLinkHealth | undefined
  state: MachineLinkState
  /** The target's link to the source; null for a one-way link. */
  back: { pairing: HostPairing; health: HostLinkHealth | undefined; state: MachineLinkState } | null
  /** One-way, and the target can link to the source now: it is connected, its owner is here, and the source is in its choices. */
  canLinkBack: boolean
}

/**
 * Every link that the machines hold, once each: a two-way link is one view,
 * from the source listed first. `health` is each machine's last health read, by
 * the installation id of the machine that holds the links; `unavailable` when it
 * could not give one.
 */
export function machineLinkViews(machines: readonly LinkMachine[], health: ReadonlyMap<string, readonly HostLinkHealth[] | 'unavailable'>, now: number): MachineLinkView[] {
  const healthOf = (sourceId: string, targetId: string): HostLinkHealth | 'unavailable' | undefined => {
    const read = health.get(sourceId)
    return read === 'unavailable' ? read : read?.find((entry) => entry.installationId === targetId)
  }
  const bySource = new Map(machines.map((machine) => [machine.info.installationId, machine]))
  const views: MachineLinkView[] = []
  const seen = new Set<string>()
  for (const machine of machines) {
    const sourceId = machine.info.installationId
    for (const pairing of machine.snapshot?.hosts ?? []) {
      const targetId = pairing.listing.installationId
      if (seen.has(`${sourceId}>${targetId}`)) continue
      seen.add(`${sourceId}>${targetId}`)
      const target = bySource.get(targetId)
      const backPairing = target?.snapshot?.hosts.find((other) => other.listing.installationId === sourceId)
      if (backPairing) seen.add(`${targetId}>${sourceId}`)
      const linkHealth = healthOf(sourceId, targetId)
      const backHealth = backPairing ? healthOf(targetId, sourceId) : undefined
      views.push({
        id: `${sourceId}>${targetId}`,
        sourceId,
        sourceLabel: machine.label,
        targetId,
        targetLabel: target?.label ?? pairing.listing.label,
        pairing,
        health: linkHealth === 'unavailable' ? undefined : linkHealth,
        state: machineLinkState(linkHealth, now),
        back: backPairing ? { pairing: backPairing, health: backHealth === 'unavailable' ? undefined : backHealth, state: machineLinkState(backHealth, now) } : null,
        canLinkBack: !backPairing && !!target && machineLinkChoices(target, machines).some((choice) => choice.id === sourceId),
      })
    }
  }
  return views
}

/** A machine that a link reaches and that this device has no entry for: it knows it only through the link. */
export interface LinkedOnlyMachine {
  installationId: string
  label: string
  /** The address of the first link to it. */
  url: string | null
  /** The machines that link to it. */
  viaLabels: string[]
}

export function linkedOnlyMachines(views: readonly MachineLinkView[], knownIds: ReadonlySet<string>): LinkedOnlyMachine[] {
  const found = new Map<string, LinkedOnlyMachine>()
  const add = (id: string, label: string, pairing: HostPairing, viaLabel: string) => {
    if (knownIds.has(id)) return
    const machine = found.get(id) ?? { installationId: id, label, url: pairedHostRoute(pairing)?.url ?? null, viaLabels: [] }
    if (!machine.viaLabels.includes(viaLabel)) machine.viaLabels.push(viaLabel)
    found.set(id, machine)
  }
  // A machine that holds links is connected here, so only a target can be unknown.
  for (const view of views) add(view.targetId, view.targetLabel, view.pairing, view.sourceLabel)
  return [...found.values()]
}

/** Why the links a machine holds are not shown. */
export type MachineLinksHidden = 'disconnected' | 'not-owner' | 'reading' | 'failed'

export function machineLinksHidden(input: {
  isConnected: boolean
  info: Pick<ConnectionsServerInfo, 'principal' | 'permissions'> | null
  hasSnapshot: boolean
  hasReadFailed: boolean
}): MachineLinksHidden | null {
  if (!input.isConnected) return 'disconnected'
  if (!input.info) return 'reading'
  if (!canManageMachineLinks(input.info)) return 'not-owner'
  if (input.hasSnapshot) return null
  return input.hasReadFailed ? 'failed' : 'reading'
}

export function machineLinksHiddenText(reason: MachineLinksHidden): string {
  switch (reason) {
    case 'disconnected': return 'Not connected, so its machine links are not shown.'
    case 'not-owner': return 'Only its owner can see its machine links.'
    case 'reading': return 'Reading its machine links…'
    case 'failed': return 'Could not read its machine links.'
  }
}
