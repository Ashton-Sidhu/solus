/**
 * Persists the list of paired Solus servers in localStorage. Lets the user
 * connect to multiple machines and switch without re-pairing each time.
 */

import type { HostOperatingSystem } from '@solus/contracts/types'
import { z } from 'zod'
import { forwardCompatibleArray } from './forward-compat'

const KEY = 'solus.servers'
const ACTIVE_KEY = 'solus.activeServerId'

export const LOCAL_SERVER_ID = 'local'

export interface SavedServer {
  id: string
  label: string
  /** Server URL as the user entered it, e.g. `http://192.168.1.42:51234`. */
  url: string
  /** Long-lived session token from POST /pair. */
  sessionToken: string
  /** Last-known installation id (so we can warn if the server identity changed). */
  installationId: string
  /** Last-known operating system reported by the host. */
  os?: HostOperatingSystem
  lastConnected: number
}

type ServerSavedListener = (server: SavedServer) => void
type ServerRemovingListener = (server: SavedServer) => void

const serverSavedListeners = new Set<ServerSavedListener>()
const serverRemovingListeners = new Set<ServerRemovingListener>()

export function onServerSaved(listener: ServerSavedListener): () => void {
  serverSavedListeners.add(listener)
  return () => serverSavedListeners.delete(listener)
}

export function onServerRemoving(listener: ServerRemovingListener): () => void {
  serverRemovingListeners.add(listener)
  return () => serverRemovingListeners.delete(listener)
}

export type InstallationIdDecision = 'match' | 'mismatch'

export function installationIdDecision(
  storedInstallationId: string,
  reportedInstallationId: string,
): InstallationIdDecision {
  return storedInstallationId === reportedInstallationId ? 'match' : 'mismatch'
}

// `id` and `url` are load-bearing (they route sockets); everything else
// degrades alone. `.passthrough()` keeps fields written by a newer client
// build intact across the load→save round trip.
const savedServerSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string().catch(''),
  url: z.string().min(1),
  sessionToken: z.string().catch(''),
  installationId: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
  lastConnected: z.number().catch(0),
})
const savedServersSchema = forwardCompatibleArray(savedServerSchema)

export function loadServers(): SavedServer[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const decoded = savedServersSchema.safeParse(JSON.parse(raw))
    if (decoded.success) {
      // SAFETY: Every surviving element passed savedServerSchema, whose fields
      // mirror SavedServer; loose passthrough keys widen, never narrow.
      return decoded.data as SavedServer[]
    }
  } catch {}
  // An unreadable blob would be re-parsed and re-failed on every boot: delete
  // it and treat it as a miss. Records that merely fail element decode are
  // dropped from the result, not from storage.
  try {
    localStorage.removeItem(KEY)
  } catch {}
  return []
}

export function saveServers(servers: SavedServer[]): void {
  localStorage.setItem(KEY, JSON.stringify(servers))
}

export function upsertServer(server: SavedServer): void {
  const servers = loadServers()
  const idx = servers.findIndex(s => s.id === server.id || s.url === server.url)
  if (idx >= 0) servers[idx] = server
  else servers.push(server)
  saveServers(servers)
  for (const listener of serverSavedListeners) listener(server)
}

export function removeServer(id: string): void {
  const servers = loadServers()
  const server = servers.find((candidate) => candidate.id === id)
  if (server) {
    for (const listener of serverRemovingListeners) listener(server)
  }
  saveServers(servers.filter(s => s.id !== id))
  if (getActiveServerId() === id) setActiveServerId(LOCAL_SERVER_ID)
}

export function touchLastConnected(id: string): void {
  const servers = loadServers()
  const target = servers.find(s => s.id === id)
  if (target) {
    target.lastConnected = Date.now()
    saveServers(servers)
  }
}

export function stampHostOperatingSystem(id: string, os: HostOperatingSystem): void {
  const servers = loadServers()
  const target = servers.find(s => s.id === id)
  if (!target || target.os === os) return
  target.os = os
  saveServers(servers)
}

export function getActiveServerId(): string {
  return localStorage.getItem(ACTIVE_KEY) || LOCAL_SERVER_ID
}

export function setActiveServerId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id || LOCAL_SERVER_ID)
}

export function clearActiveServerId(): void {
  localStorage.removeItem(ACTIVE_KEY)
}
