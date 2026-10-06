import { useEffect, useState } from 'react'
import { hasHostCapability } from '@solus/client-core/host-capabilities'
import { faviconCandidatePaths, normalizedProjectRoot } from '@solus/client-core/project-favicon-paths'
import type { HostConnection } from '../features/hosts/host-connections'

/**
 * A project's favicon on the phone, found the way the web finds it
 * (`packages/workspace-ui/src/lib/project-favicon.ts`): the project's host
 * serves the first candidate file it has and signs a short-lived URL on its
 * own origin. The phone never reads a host path itself.
 */

/** How long "this project has no favicon" holds before the host is asked again. */
const MISSING_TTL_MS = 5 * 60_000
/** A signed URL is renewed this long before it expires. */
const REFRESH_WINDOW_MS = 60_000

interface Found {
  url: string | null
  expiresAt: number
}

const found = new Map<string, Found>()
const pending = new Map<string, Promise<string | null>>()

async function find(connection: HostConnection, projectRoot: string): Promise<Found> {
  const capabilities = await connection.supervisor.whenCapabilities()
  // A capability read that failed (asked before the host connected) answers
  // empty. That says nothing about the project, so it is not remembered.
  if (capabilities.assetUrls === undefined) throw new Error('The host has not said whether it serves assets.')
  if (!hasHostCapability(capabilities, 'assetUrls')) {
    return { url: null, expiresAt: Date.now() + MISSING_TTL_MS }
  }
  const result = await connection.api.assetFindUrl(undefined, { paths: faviconCandidatePaths(projectRoot) })
  if (!result) return { url: null, expiresAt: Date.now() + MISSING_TTL_MS }
  const origin = new URL(connection.transport.serverUrl).origin
  return { url: new URL(result.relativeUrl, `${origin}/`).toString(), expiresAt: result.expiresAt }
}

/** The favicon URL of a project on a host, or null when it has none. A host
 *  that does not answer is not remembered, so the next request asks again. */
export function resolveProjectFaviconUrl(connection: HostConnection, projectRoot: string): Promise<string | null> {
  const key = `${connection.hostId}\u0000${normalizedProjectRoot(projectRoot)}`
  const cached = found.get(key)
  if (cached && cached.expiresAt - Date.now() > REFRESH_WINDOW_MS) return Promise.resolve(cached.url)
  const existing = pending.get(key)
  if (existing) return existing
  const request = find(connection, projectRoot).then(
    (result) => {
      found.set(key, result)
      return result.url
    },
    () => null,
  )
  pending.set(key, request)
  void request.finally(() => { if (pending.get(key) === request) pending.delete(key) })
  return request
}

/**
 * The favicon URL while a view shows the project; null until it is known.
 * The host is asked only while it is connected (`connectedGeneration` is
 * non-null), and again on each new connection, so a list drawn before the
 * host answered still gets its favicons. A known URL stays through a drop.
 */
export function useProjectFaviconUrl(
  connection: HostConnection | null,
  projectRoot: string | null,
  connectedGeneration: number | null,
): string | null {
  const key = connection && projectRoot ? `${connection.hostId}\u0000${projectRoot}` : null
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!connection || !projectRoot || key === null || connectedGeneration === null) return
    let active = true
    void resolveProjectFaviconUrl(connection, projectRoot).then((url) => {
      if (active) setLoaded((current) => (url === null && current?.key === key ? current : { key, url }))
    })
    return () => { active = false }
  }, [connection, projectRoot, key, connectedGeneration])
  return loaded && loaded.key === key ? loaded.url : null
}
