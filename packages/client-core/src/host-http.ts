import { z } from 'zod'
import { healthProofSchema, type HealthProof } from '@solus/contracts/host-identity'
import type { HostOperatingSystem } from '@solus/contracts/types'
import { httpClient } from './http-request'

/**
 * The calls to a host outside RPC (plans/032 D5): its `/health`, read before a
 * socket exists, and its `/auth/refresh`, which renews the session token a socket
 * signs in with.
 */

/** What a host's `/health` says about it. */
export interface HostHealth {
  ok: boolean
  installationId: string
  name: string
  os?: HostOperatingSystem
  /** Present when the read sent a nonce: the host's signature over it. */
  proof?: HealthProof
}

// `ok` and `installationId` are the identity contract and stay required;
// everything else degrades alone so a newer host's additions never null the
// whole health record and silently stop identity verification. A host leaves
// `name` out of a reply through its tunnel, so a missing name is empty.
const hostHealthSchema = z.object({
  ok: z.literal(true),
  installationId: z.string().min(1),
  name: z.string().catch(''),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
  proof: healthProofSchema.optional().catch(undefined),
})

/** One `/health` read, with no credential; null when the route did not answer as a Solus host. With a nonce, the host signs it. */
export async function readHostHealth(fetchImpl: typeof fetch, url: string, signal: AbortSignal, nonce?: string): Promise<HostHealth | null> {
  try {
    const response = await fetchImpl(nonce ? `${url}/health?nonce=${encodeURIComponent(nonce)}` : `${url}/health`, { signal })
    if (!response.ok) return null
    const health = hostHealthSchema.safeParse(await response.json())
    return health.success ? health.data : null
  } catch {
    return null
  }
}

export type HostSessionRefresh = { result: 'refreshed'; sessionToken: string } | { result: 'unauthorized' | 'unavailable' }

const sessionRefreshSchema = z.object({ sessionToken: z.string().min(1) })

/** A new session token from the host at `url`; `unauthorized` when the host refused `sessionToken`. */
export async function refreshHostSession(fetchImpl: typeof fetch, url: string, sessionToken: string, timeoutMs: number): Promise<HostSessionRefresh> {
  const host = httpClient({ baseUrl: url, token: async () => sessionToken, timeoutMs, fetch: fetchImpl })
  const result = await host.request('/auth/refresh', { method: 'POST' })
  if (result.kind !== 'response') return { result: 'unavailable' }
  if (result.response.status === 401) return { result: 'unauthorized' }
  if (!result.response.ok) return { result: 'unavailable' }
  const body = sessionRefreshSchema.safeParse(await result.response.json().catch(() => null))
  return body.success ? { result: 'refreshed', sessionToken: body.data.sessionToken } : { result: 'unavailable' }
}
