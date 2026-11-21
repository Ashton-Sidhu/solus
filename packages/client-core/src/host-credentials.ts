/**
 * What this device keeps about each host (plans/033 §2 rule 2, §4.1): its
 * credential and the facts that only this device knows about how to dial. No
 * label, OS, last connection, or directory fact: the host catalog reads those
 * from the person's host list and the account directory (`host-catalog.ts`).
 *
 * The storage is a port: `localStorage` on desktop and web
 * (`localStorageCredentials`), the keychain on mobile.
 */

import { z } from 'zod'
import { hostRouteSchema, type HostRoute, type RouteSource } from '@solus/contracts/host-routes'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import { forwardCompatibleArray } from './forward-compat'

export interface HostCredential {
  /** The session token from POST /pair. Empty when this device keeps only how it dials a host it reaches with a grant. */
  token: string
  /** The host's identity key (docs/plans/host-routes.md D3), from the pairing or the first proof. */
  identityKey?: string
  /** `token` was paired over HTTPS, so it stays off routes that carry it in clear. */
  tokenPairedOverHttps?: boolean
  /** Only the routes this device knows (`DEVICE_ROUTE_SOURCES`). */
  routes: HostRoute[]
  /** Route URLs in the order the person chose on this device. Absent is the default order. */
  routeOrder?: string[]
}

/**
 * The route sources that only this device knows: its pairing address, the routes
 * the person added here, the LAN routes a scan found here, the forwards this
 * machine's host holds, and the page's own origin. A route with no source is a
 * pairing route (`routesFrom`).
 */
export const DEVICE_ROUTE_SOURCES: ReadonlySet<RouteSource> = new Set(['pairing', 'user', 'discovery', 'ssh', 'page'])

export function isDeviceRoute(route: HostRoute): boolean {
  return DEVICE_ROUTE_SOURCES.has(route.source ?? 'pairing')
}

/** The routes of `routes` that a credential keeps. */
export function deviceRoutes(routes: readonly HostRoute[]): HostRoute[] {
  return routes.filter(isDeviceRoute)
}

/** Where a device keeps its credentials. Each call is one host; `read` answers every host. */
export interface HostCredentialStorage {
  read(): Promise<ReadonlyMap<string, HostCredential>>
  write(hostId: string, credential: HostCredential): Promise<void>
  remove(hostId: string): Promise<void>
}

export const HOST_CREDENTIALS_KEY = 'solus.hostCredentials'
const RETIRED_KEYS = ['solus.servers', 'solus.workspaces']

const credentialSchema = z.object({
  hostId: z.string().min(1),
  token: z.string().catch(''),
  identityKey: hostIdentityKeySchema.optional().catch(undefined),
  tokenPairedOverHttps: z.boolean().optional().catch(undefined),
  routes: forwardCompatibleArray(hostRouteSchema).catch([]),
  routeOrder: z.array(z.string()).optional().catch(undefined),
})
const credentialsSchema = forwardCompatibleArray(credentialSchema)

/** The stored form: one entry per host, with its id. */
export function encodeCredentials(credentials: ReadonlyMap<string, HostCredential>): string {
  return JSON.stringify([...credentials].map(([hostId, credential]) => ({ hostId, ...credential })))
}

/** Every entry that decodes; an entry this build cannot read is dropped. Null when the text is not a list. */
export function decodeCredentials(raw: string): Map<string, HostCredential> | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const decoded = credentialsSchema.safeParse(value)
  if (!decoded.success) return null
  const credentials = new Map<string, HostCredential>()
  for (const { hostId, ...entry } of decoded.data) {
    const credential: HostCredential = { token: entry.token, routes: entry.routes }
    if (entry.identityKey) credential.identityKey = entry.identityKey
    if (entry.tokenPairedOverHttps) credential.tokenPairedOverHttps = true
    if (entry.routeOrder) credential.routeOrder = entry.routeOrder
    credentials.set(hostId, credential)
  }
  return credentials
}

/** The part of `Storage` the adapter uses; `localStorage` when absent. */
export interface CredentialTextStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Desktop and web: every credential in one `localStorage` entry. */
export function localStorageCredentials(storage: () => CredentialTextStorage | null = () => globalThis.localStorage ?? null): HostCredentialStorage {
  const readAll = (): Map<string, HostCredential> => {
    let raw: string | null = null
    try {
      raw = storage()?.getItem(HOST_CREDENTIALS_KEY) ?? null
    } catch {}
    if (!raw) return new Map()
    const decoded = decodeCredentials(raw)
    if (decoded) return decoded
    // An unreadable entry would fail again on every boot.
    try {
      storage()?.removeItem(HOST_CREDENTIALS_KEY)
    } catch {}
    return new Map()
  }
  const writeAll = (credentials: ReadonlyMap<string, HostCredential>): void => {
    const target = storage()
    if (!target) return
    if (credentials.size === 0) target.removeItem(HOST_CREDENTIALS_KEY)
    else target.setItem(HOST_CREDENTIALS_KEY, encodeCredentials(credentials))
  }
  return {
    read: async () => {
      // Before plan 033 the device kept whole hosts and the workspace services. They
      // are deleted, not read (§2 rule 5): there are no users to migrate.
      try {
        for (const key of RETIRED_KEYS) storage()?.removeItem(key)
      } catch {}
      return readAll()
    },
    write: async (hostId, credential) => {
      const credentials = readAll()
      credentials.set(hostId, credential)
      writeAll(credentials)
    },
    remove: async (hostId) => {
      const credentials = readAll()
      if (credentials.delete(hostId)) writeAll(credentials)
    },
  }
}
