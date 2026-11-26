import type { Env, Hono } from 'hono'
import { Readable } from 'node:stream'
import { SESSION_BUNDLE_CONTENT_TYPE, SESSION_BUNDLE_ROUTE_PREFIX, type SessionBundleTransfers } from '../sync/sessions/session-bundle-transfers'

/** Only `bytes=<start>-`: a dropped stream continues from its last byte. Null for each other form. */
function openRangeStart(range: string): number | null {
  const match = /^bytes=(\d+)-$/.exec(range.trim())
  return match ? Number(match[1]) : null
}

/**
 * Another host downloads the file of one session bundle transfer as one stream
 * (docs/plans/session-storage.md §8). The download secret of the transfer is the
 * credential: `sessionRepositoryBundle` gave it only to a caller with prompt
 * standing. It is in the `Authorization` header, never in the URL.
 */
export function registerSessionBundleRoute<E extends Env>(app: Hono<E>, transfers: Pick<SessionBundleTransfers, 'download'> | undefined): void {
  if (!transfers) return
  app.get(`${SESSION_BUNDLE_ROUTE_PREFIX}:transferId`, (c) => {
    const header = c.req.header('authorization') ?? ''
    const secret = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    if (!secret) return c.json({ error: 'Unauthorized' }, 401)
    const range = c.req.header('range')
    const start = range === undefined ? 0 : openRangeStart(range) ?? Number.NaN
    const download = transfers.download(c.req.param('transferId'), secret, start)
    if (download.kind === 'refused') return c.json({ error: 'Unauthorized' }, 401)
    if (download.kind === 'bad-range') {
      return new Response(null, { status: 416, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${download.size}` } })
    }
    const headers = {
      'content-type': SESSION_BUNDLE_CONTENT_TYPE,
      'content-length': String(download.size - download.start),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    }
    // SAFETY: a file read stream gives only bytes, so its web stream is a stream of Uint8Array.
    const body = Readable.toWeb(download.stream) as ReadableStream<Uint8Array>
    if (range === undefined) return new Response(body, { status: 200, headers })
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${download.start}-${download.size - 1}/${download.size}` },
    })
  })
}
