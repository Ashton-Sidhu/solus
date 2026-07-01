/**
 * Persists the list of paired Solus servers in localStorage. Lets the user
 * connect to multiple machines (work laptop, home machine) and switch between
 * them without re-pairing each time.
 */

const KEY = 'solus.servers'

export interface SavedServer {
  id: string
  label: string
  /** Server URL as the user entered it, e.g. `http://192.168.1.42:51234`. */
  url: string
  /** Long-lived session token from POST /pair. */
  sessionToken: string
  /** Last-known installation id (so we can warn if the server identity changed). */
  installationId?: string
  lastConnected: number
}

export function loadServers(): SavedServer[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
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
}

export function removeServer(id: string): void {
  saveServers(loadServers().filter(s => s.id !== id))
}

export function touchLastConnected(id: string): void {
  const servers = loadServers()
  const target = servers.find(s => s.id === id)
  if (target) {
    target.lastConnected = Date.now()
    saveServers(servers)
  }
}
