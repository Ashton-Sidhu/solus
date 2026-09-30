import { createReadStream } from 'fs'
import { stat as readFileStat } from 'fs/promises'
import { Readable } from 'stream'
import { createLogger } from '@solus/server/logger'
import { videoMimeType } from '@solus/contracts/media-types'

const log = createLogger('main', 'local-video-protocol')

/**
 * `solus-local-video://local/?p=<path>` streams a video on this computer into
 * the renderer, so a video picked here uploads to a remote host without being
 * copied through IPC as base64. Host files never use it: every client loads
 * them from a signed asset URL.
 */
export async function handleLocalVideoRequest(request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
    }
    const filePath = new URL(request.url).searchParams.get('p')
    if (!filePath) return new Response('Missing path', { status: 400 })
    const mime = videoMimeType({ name: filePath })
    if (!mime) return new Response('Unsupported type', { status: 415 })

    const stat = await readFileStat(filePath).catch(() => null)
    if (!stat?.isFile()) return new Response('Not found', { status: 404 })

    // SAFETY: `Readable.toWeb` returns the web stream body accepted by the Fetch `Response` constructor.
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': mime, 'Content-Length': String(stat.size) },
    })
  } catch (error) {
    log.warn('local_video_request_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return new Response('Error', { status: 500 })
  }
}
