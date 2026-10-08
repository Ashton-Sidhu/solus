import { useCallback, useEffect, useRef, useState } from 'react'
import { hasHostCapability } from '@solus/client-core/host-capabilities'
import type { IpcContext } from '@solus/contracts/types'
import type { HostConnection } from '../hosts/host-connections'

/**
 * A URL the phone can load for a file on a host, the way the web client gets
 * one (`host-media-url.svelte.ts`). The phone never reads a host path itself:
 * the host signs a short-lived URL on its own origin, and this cache renews it
 * one minute before it expires.
 */

const REFRESH_WINDOW_MS = 60_000

export type HostMediaRequest =
  | {
      /** A path on the host: absolute, `~`-relative, or relative to the project `ctx` names. */
      path: string
      ctx?: IpcContext
    }
  /** A file in the host asset store, such as a picture a tool returned. */
  | { assetId: string; ctx?: undefined }

interface SignedUrl {
  url: string
  expiresAt: number
}

const signedUrls = new Map<string, SignedUrl>()
const pendingMints = new Map<string, Promise<SignedUrl>>()

const cacheKey = (hostId: string, request: HostMediaRequest) =>
  'assetId' in request
    ? `${hostId}\u0000asset\u0000${request.assetId}`
    : `${hostId}\u0000${request.ctx?.session.workingDirectory ?? ''}\u0000${request.path}`

async function mint(connection: HostConnection, request: HostMediaRequest): Promise<SignedUrl> {
  if (!hasHostCapability(await connection.facts.when('capabilities'), 'assetUrls')) {
    throw new Error('Update the host to show media from it.')
  }
  const signed = 'assetId' in request
    ? await connection.api.assetCreateUrl(undefined, { assetId: request.assetId })
    : await connection.api.assetCreateUrl(request.ctx, { path: request.path })
  const origin = new URL(connection.transport.serverUrl).origin
  return { url: new URL(signed.relativeUrl, `${origin}/`).toString(), expiresAt: signed.expiresAt }
}

/** A signed URL for a host file. `refresh` mints a new one even when the cached one has time left. */
export async function resolveHostMediaUrl(
  connection: HostConnection,
  request: HostMediaRequest,
  refresh = false,
): Promise<string> {
  const key = cacheKey(connection.hostId, request)
  const cached = signedUrls.get(key)
  if (!refresh && cached && cached.expiresAt - Date.now() > REFRESH_WINDOW_MS) return cached.url
  let pending = pendingMints.get(key)
  if (!pending) {
    pending = mint(connection, request)
    pendingMints.set(key, pending)
    const settled = pending
    void settled.then(
      () => { if (pendingMints.get(key) === settled) pendingMints.delete(key) },
      () => { if (pendingMints.get(key) === settled) pendingMints.delete(key) },
    )
  }
  const signed = await pending
  signedUrls.set(key, signed)
  return signed.url
}

export type HostMediaUrlState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'failed'; message: string }

/**
 * The URL of one host file while a screen shows it. Null `request` shows
 * nothing. The request is read by its host, path, and project, so a caller
 * may build a new request object on every render.
 */
export function useHostMediaUrl(
  connection: HostConnection | null,
  request: HostMediaRequest | null,
): { state: HostMediaUrlState; refresh: () => Promise<string | null> } {
  const key = connection && request ? cacheKey(connection.hostId, request) : null
  const requestRef = useRef(request)
  useEffect(() => { requestRef.current = request })
  const [loaded, setLoaded] = useState<{ key: string; state: HostMediaUrlState } | null>(null)

  useEffect(() => {
    const current = requestRef.current
    if (!connection || !current || key === null) return
    let active = true
    resolveHostMediaUrl(connection, current).then(
      (url) => { if (active) setLoaded({ key, state: { kind: 'ready', url } }) },
      (cause: unknown) => {
        if (active) setLoaded({ key, state: { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) } })
      },
    )
    return () => { active = false }
  }, [connection, key])

  const refresh = useCallback(async () => {
    const current = requestRef.current
    if (!connection || !current) return null
    return resolveHostMediaUrl(connection, current, true).catch(() => null)
  }, [connection])

  return { state: loaded && loaded.key === key ? loaded.state : { kind: 'loading' }, refresh }
}
