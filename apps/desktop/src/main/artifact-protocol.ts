import { createReadStream } from 'fs'
import { stat as readFileStat } from 'fs/promises'
import { extname } from 'path'
import { Readable } from 'stream'
import { createLogger } from '@solus/server/logger'
import { parseByteRange } from '@solus/server/server/byte-range'

const log = createLogger('main', 'artifact-protocol')

/** Image MIME types served over solus-artifact://, keyed by lowercased extension. */
const ARTIFACT_MIME = new Map([
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
])

/** Decode and stream an image file requested through solus-artifact://. */
export async function handleArtifactRequest(request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }

    const url = new URL(request.url)
    const filePath = url.searchParams.get('p')
    if (!filePath) return new Response('Missing path', { status: 400 })
    const mime = ARTIFACT_MIME.get(extname(filePath).toLowerCase())
    if (!mime) return new Response('Unsupported type', { status: 415 })

    let stat
    try {
      stat = await readFileStat(filePath)
    } catch {
      return url.searchParams.has('optional')
        ? new Response(null, { status: 204 })
        : new Response('Not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('Not found', { status: 404 })

    const requestedRange = request.headers.get('range') ?? undefined
    const range = parseByteRange(requestedRange, stat.size)
    if (requestedRange && !range) {
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${stat.size}`,
        },
      })
    }

    const start = range?.start ?? 0
    const end = range?.end ?? stat.size - 1
    const headers: HeadersInit = {
      'Content-Type': mime,
      'Content-Length': String(range ? end - start + 1 : stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Security-Policy': "default-src 'none'; img-src data: *; style-src 'unsafe-inline'",
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
    if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })

    const fileStream = createReadStream(filePath, range ? { start, end } : undefined)
    // SAFETY: `Readable.toWeb` returns the web stream body accepted by the Fetch `Response` constructor.
    const body = Readable.toWeb(fileStream) as ReadableStream
    return new Response(body, {
      status: range ? 206 : 200,
      headers,
    })
  } catch (error) {
    log.warn('artifact_request_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return new Response('Error', { status: 500 })
  }
}
