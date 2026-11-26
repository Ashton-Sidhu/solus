/**
 * A host this client knows, as the host catalog joins it (`host-catalog.ts`;
 * plans/033 §4.1): the person's host list, the account directory, and this
 * device's credential, by host id. Nothing here is saved: the catalog builds a
 * `KnownHost` again from its answers. The organizations' workspace services are
 * kept apart (`workspace-registry.ts`).
 */

import type { HostOperatingSystem } from '@solus/contracts/types'
import { isSolusApiId, type MachineKind, type ManagedHostLifecycle } from '@solus/contracts/uplink'
import { mergeRoutes, routeForUrl, routesFrom, type HostRoute } from '@solus/contracts/host-routes'
import type { SshAddResult } from '@solus/contracts/remote-machines'
import type { GuestCredential } from './ws-transport'

const ACTIVE_KEY = 'solus.activeServerId'

export const LOCAL_SERVER_ID = 'local'

/** The host is listed in the owner's Solus cloud directory and dialable with a grant. */
export interface KnownHostUplink {
  hostId: string
  /** The account origin whose directory named it, e.g. `https://app.solus.sh`. */
  directoryUrl: string
  /** The organizations whose members may reach the host, as the directory last
   *  said (organization-scope §3.1, R15): the ones a personal host is shared
   *  with, or the one a cloud machine works for. Absent when it is shared with none. */
  organizationIds?: string[]
  /** Whose machine this is, for a host shared with the account rather than linked by it. */
  ownerName?: string
  /** The account that linked a personal host, so its `host-owner` presence is one person with their account elsewhere. */
  ownerUserId?: string
  /** `cloud` for a cloud machine of an organization (plans/034-one-cloud-machine-kind.md); absent is personal. */
  kind?: MachineKind
  /** The control plane operates this cloud machine's compute, so it has a lifecycle (`managedState`) to start and stop. */
  hasManagedCompute?: boolean
  /** Only with `hasManagedCompute`: what the control plane last said of the compute. Only a `ready` one is dialed. */
  managedState?: ManagedHostLifecycle
}

/**
 * A cloud machine with managed compute that the directory does not call `ready`. The
 * client does not dial it and does not send work to it. The directory names a state
 * for every such machine, so a state that is missing (or one this client does not
 * know) is not ready. A personal host, and a cloud machine that its operator runs,
 * never wait.
 */
export function awaitsManagedCompute(uplink: KnownHostUplink | undefined): boolean {
  return uplink?.hasManagedCompute === true && uplink.managedState !== 'ready'
}

/** Whether a host belongs to an organization: shared with it, or its cloud machine. */
export function hostInOrganization(uplink: Pick<KnownHostUplink, 'organizationIds'> | undefined, organizationId: string | null): boolean {
  return !!organizationId && !!uplink?.organizationIds?.includes(organizationId)
}

/**
 * Whether a managed host must be asked to start before a client waits for it. A
 * host that is ready, or still being set up, is only waited for: a start would run
 * a second reconcile beside the setup already running on Solus Cloud. A failed
 * host is asked again, which retries its setup.
 */
export function managedHostNeedsStart(lifecycle: ManagedHostLifecycle | undefined): boolean {
  return lifecycle === 'stopped' || lifecycle === 'stopping' || lifecycle === 'failed'
}

export interface KnownHost {
  id: string
  label: string
  /** The user typed `label` themselves rather than the client deriving it from an
   *  address or a name the host reported. Their wording then outranks the name the
   *  host advertises over the connection. */
  hasUserLabel?: boolean
  /** This device's session token from POST /pair. Empty when this device holds no
   *  credential for the host: it is dialed with a short grant instead. */
  sessionToken: string
  /** Last-known installation id (so we can warn if the server identity changed). */
  installationId: string
  /** Last-known operating system reported by the host. */
  os?: HostOperatingSystem
  lastConnected: number
  /** Every way this client knows to reach the host, each with its source
   *  (docs/plans/host-routes.md D1). Change it only through the catalog. */
  routes: HostRoute[]
  /** Route URLs in the order the person chose on this client (§12). Absent is the default order. */
  routeOrder?: string[]
  /** `sessionToken` was paired over HTTPS, so it stays off routes that carry it in clear. */
  tokenPairedOverHttps?: boolean
  /** The owner host's pairing `sessionToken` came from (`HostCredential.ownerPairedAt`). */
  ownerPairedAt?: number
  /** The host's identity key (docs/plans/host-routes.md D3), from the pairing, the
   *  SSH connection that added it, or its first connection through the tunnel. An
   *  `http:` route is dialed only after the host proves this key. */
  identityKey?: string
  uplink?: KnownHostUplink
  /** The desktop's own machine: known for this page only (`HostCatalog.addPageHost`). */
  local?: boolean
  /** A guest of a share link (docs/plans/multiplayer-sharing.md §4.2): the link's
   *  secret is the one credential. Known for this page only; no account, no saved host. */
  guest?: GuestCredential
  /** Routes dialed only when no route in `routes` answers: a guest's read-only mirror of the resource. */
  fallbackRoutes?: HostRoute[]
}

/**
 * Where new work runs when nothing narrower names a machine
 * (docs/plans/workspace-and-machines.md §5.1). The primary is kept when it is a
 * machine — the desktop's own, or the machine a web page was served by. At the
 * account origin the primary is the workspace service, which runs nothing, so the
 * choice falls to the active organization's managed host, then to any machine,
 * and only among connected ones: a call sent to a machine that is not there
 * waits for as long as it stays away. Null is "no machine", never the service.
 */
export function chooseRunOnHost(input: {
  primaryId: string | null
  localId: string | null
  known: readonly KnownHost[]
  activeOrganizationId: string | null
  isConnected: (serverId: string) => boolean
}): string | null {
  const { primaryId, localId, known, activeOrganizationId, isConnected } = input
  if (primaryId && !isSolusApiId(primaryId)) return primaryId
  if (localId) return localId
  const machines = known.filter((host) => isConnected(host.id))
  const cloudMachine = machines.find((host) => host.uplink?.kind === 'cloud' && hostInOrganization(host.uplink, activeOrganizationId))
  return (cloudMachine ?? machines[0])?.id ?? null
}

/** The address this client paired the host at, if it paired it. */
export function pairedAddress(host: Pick<KnownHost, 'routes'>): string | null {
  return routesFrom(host.routes, 'pairing')[0]?.url ?? null
}

/**
 * The host an SSH add gives this client (docs/plans/host-routes.md D6, D7). A
 * discovered server is dialed at the address it was found at; a machine SSH alone
 * reaches is dialed through the forward its host holds. Either way the identity key
 * came over the SSH connection, so the first dial can prove the host. The caller
 * pairs it with the catalog.
 */
export function serverFromSshAdd(result: Extract<SshAddResult, { status: 'session' | 'forwarded' }>, discoveredUrl: string | null, now = Date.now()): KnownHost {
  const added = result.status === 'session'
    ? { installationId: result.installationId, label: result.label, os: result.os, identityKey: result.identityKey, routes: discoveredUrl ? mergeRoutes([], [routeForUrl(discoveredUrl)], 'pairing', now) : [] }
    : { installationId: result.host.installationId, label: result.host.label, os: result.host.os, identityKey: result.host.identityKey, routes: mergeRoutes([], [result.host.route], 'ssh', now) }
  const host: KnownHost = {
    id: added.installationId,
    label: added.label,
    routes: added.routes,
    sessionToken: result.sessionToken,
    installationId: added.installationId,
    identityKey: added.identityKey,
    lastConnected: now,
  }
  if (added.os) host.os = added.os
  return host
}

export type InstallationIdDecision = 'match' | 'mismatch'

/**
 * Whether the host on a known address is still the one known there. A cloud machine
 * is known under its directory id, never the id its server makes at first boot, so
 * the two are not compared: the directory owns its route, and the host refuses a
 * grant minted for another host id.
 */
export function installationIdDecision(
  storedInstallationId: string,
  reportedInstallationId: string,
  uplink?: KnownHostUplink,
): InstallationIdDecision {
  if (uplink?.kind === 'cloud') return 'match'
  return storedInstallationId === reportedInstallationId ? 'match' : 'mismatch'
}

/** The host this window used last (plans/033 Q4): a choice of this window, not host data. */
export function getActiveServerId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) || LOCAL_SERVER_ID
  } catch {
    return LOCAL_SERVER_ID
  }
}

export function setActiveServerId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id || LOCAL_SERVER_ID)
  } catch {}
}
