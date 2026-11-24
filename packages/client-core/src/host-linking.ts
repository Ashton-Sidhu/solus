import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostPairing, HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import { type HostRoute, carriesTokenInClear, routeForUrl } from '@solus/contracts/host-routes'
import { permissionsAllow } from '@solus/contracts/permissions'
import type { HostApi } from './host-api'

export interface LinkMachine {
  label: string
  info: Pick<ConnectionsServerInfo, 'installationId' | 'identityKey' | 'routes' | 'principal' | 'permissions' | 'remoteAccess' | 'hostKind'>
  api: Pick<HostApi, 'hostsPair' | 'hostsPairClient' | 'hostsUnlink' | 'connectionsGeneratePairToken'>
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

export function canManageMachineLinks(info: LinkMachine['info']): boolean {
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
