import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { solusDir } from '@solus/server/platform/paths'
import { z } from 'zod'

const lockSchema = z.object({ host: z.string(), port: z.number() })
const healthSchema = z.object({ installationId: z.string() })
const pairTokenSchema = z.object({
  token: z.string(),
  code: z.string(),
  expiresAt: z.number(),
})

function candidateHosts(bindHost: string): string[] {
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
    return [bindHost]
  }
  const lan: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) lan.push(addr.address)
    }
  }
  // LAN first — loopback can collide with other local dev servers on the same port.
  return [...lan, '127.0.0.1']
}

async function isSolus(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) })
    if (!res.ok) return false
    return healthSchema.safeParse(await res.json()).success
  } catch {
    return false
  }
}

export async function mintPairUrl(): Promise<{ url: string; code: string; expiresIn: string }> {
  const lockFile = join(solusDir(), 'server.lock')
  if (!existsSync(lockFile)) {
    throw new Error(`No running Solus server detected (missing ${lockFile}). Start Solus first.`)
  }

  let lock: z.infer<typeof lockSchema>
  try {
    lock = lockSchema.parse(JSON.parse(readFileSync(lockFile, 'utf-8')))
  } catch (error) {
    throw new Error(`Failed to parse server.lock: ${error instanceof Error ? error.message : String(error)}`)
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

  const { token, code, expiresAt } = pairTokenSchema.parse(await res.json())
  const expiresInSec = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  const expiresIn = `${Math.floor(expiresInSec / 60)}m ${expiresInSec % 60}s`

  return { url: `${base}/pair#token=${token}`, code, expiresIn }
}
