import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, networkInterfaces } from 'os'

const LOCK_FILE = join(homedir(), '.solus', 'server.lock')

function candidateHosts(bindHost: string): string[] {
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
    return [bindHost]
  }
  const lan: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if ((addr as any).family === 'IPv4' && !(addr as any).internal) lan.push((addr as any).address)
    }
  }
  // LAN first — loopback can collide with other local dev servers on the same port.
  return [...lan, '127.0.0.1']
}

async function isSolus(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) })
    if (!res.ok) return false
    const body = await res.json() as any
    return Boolean(body?.installationId)
  } catch {
    return false
  }
}

export async function mintPairUrl(): Promise<{ url: string; code: string; expiresIn: string }> {
  if (!existsSync(LOCK_FILE)) {
    throw new Error('No running Solus server detected (missing ~/.solus/server.lock). Start Solus first.')
  }

  let lock: { host: string; port: number }
  try {
    lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'))
  } catch (err: any) {
    throw new Error(`Failed to parse server.lock: ${err.message}`)
  }

  const { host: bindHost, port } = lock
  if (!port) throw new Error('server.lock is missing a port.')

  let solusHost: string | null = null
  for (const host of candidateHosts(bindHost)) {
    if (await isSolus(host, port)) { solusHost = host; break }
  }

  if (!solusHost) {
    throw new Error(`Could not reach Solus on port ${port} via any local interface. Is the lock file stale? Restart Solus and try again.`)
  }

  const base = `http://${solusHost}:${port}`
  const res = await fetch(`${base}/auth/pair-token`, { method: 'POST' })

  if (!res.ok) {
    throw new Error(`Pair token request failed: ${res.status} ${res.statusText}`)
  }

  const { token, code, expiresAt } = await res.json() as any
  const expiresInSec = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  const expiresIn = `${Math.floor(expiresInSec / 60)}m ${expiresInSec % 60}s`

  return { url: `${base}/pair#token=${token}`, code, expiresIn }
}
