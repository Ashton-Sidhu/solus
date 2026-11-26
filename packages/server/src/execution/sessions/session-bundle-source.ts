import { open, type FileHandle } from 'node:fs/promises'
import { SESSION_BUNDLE_CONTENT_TYPE, SESSION_BUNDLE_ROUTE_PREFIX } from '../../sync/sessions/session-bundle-transfers'
import type { RemoteHost, RemoteHosts, ReachRequest } from '../orchestration/remote-hosts'
import { SessionSyncError, type SessionSourceRequest, type SourceBundle } from './session-sync'

const CHUNK_BYTES = 1024 * 1024
/** A dropped stream continues from its last byte this many times. */
const STREAM_RESUMES = 3
/** A stream that sends no byte for this long is dropped, and continues if it can. */
const STREAM_IDLE_MS = 30_000

/** The last run host as a source: its copy comes as one HTTP stream, or over bounded RPC calls from an older host. */
export async function fetchSessionBundle(
  hosts: RemoteHosts,
  reach: ReachRequest,
  { sessionId, have, sourceHostId, outFile, signal }: SessionSourceRequest,
): Promise<SourceBundle> {
  if (!sourceHostId) throw new SessionSyncError('source-offline', 'The last run host is not known.')
  const target = await hosts.find(reach, sourceHostId)
  if ('error' in target) throw new SessionSyncError('source-offline', `${sourceHostId} is offline or cannot be reached.`)
  const remote = hosts.connect(target)
  if ('error' in remote) throw new SessionSyncError('source-offline', `${target.label} is offline: ${remote.error}`)
  try {
    signal.throwIfAborted()
    const answer = await remote.call('session repository bundle', () => remote.api.sessionRepositoryBundle({ sessionId, have }))
    if (answer.state !== 'ready') return answer
    if (!Number.isSafeInteger(answer.size) || answer.size <= 0) throw new Error('Invalid bundle size.')
    const file = await open(outFile, 'wx', 0o600)
    try {
      const streamed = answer.downloadSecret
        ? await streamBundle(remote.httpUrl(), { transferId: answer.transferId, secret: answer.downloadSecret, size: answer.size }, file, signal)
        : 'no-route'
      if (streamed === 'no-route') await readChunks(remote, answer.transferId, answer.size, file, signal)
    } finally {
      await file.close()
    }
    return { state: 'ready', repositoryPath: outFile, head: answer.head, source: 'host' }
  } catch (error) {
    signal.throwIfAborted()
    throw new SessionSyncError('source-offline', `${target.label} is offline or its session bundle could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface StreamedTransfer { transferId: string; secret: string; size: number }

/**
 * Downloads the file of a transfer from `GET /session-bundles/<transferId>`. After a
 * dropped stream, it asks for the bytes after the last one it wrote. `no-route` when the
 * host does not have the route: an older host answers 404, or its web client page.
 */
async function streamBundle(httpUrl: string, transfer: StreamedTransfer, file: FileHandle, signal: AbortSignal): Promise<'done' | 'no-route'> {
  const url = `${httpUrl.replace(/\/+$/, '')}${SESSION_BUNDLE_ROUTE_PREFIX}${encodeURIComponent(transfer.transferId)}`
  let written = 0
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const idle = new AbortController()
    let idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS)
    try {
      const body = await openStream(url, transfer, written, AbortSignal.any([signal, idle.signal]))
      if (body === 'no-route') return 'no-route'
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS)
        if (written + value.byteLength > transfer.size) throw new BundleStreamRefused('The bundle stream is larger than the bundle.')
        await file.write(value, 0, value.byteLength, written)
        written += value.byteLength
      }
      if (written === transfer.size) return 'done'
      throw new Error('The bundle stream ended before the end of the bundle.')
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof BundleStreamRefused || attempt >= STREAM_RESUMES) throw error
    } finally {
      clearTimeout(idleTimer)
    }
  }
}

/** The body of one request for the bytes from `written` to the end, after its answer is checked. */
async function openStream(url: string, transfer: StreamedTransfer, written: number, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | 'no-route'> {
  const headers = new Headers({ authorization: `Bearer ${transfer.secret}` })
  if (written > 0) headers.set('range', `bytes=${written}-`)
  const response = await fetch(url, { headers, signal })
  const isBundle = response.headers.get('content-type') === SESSION_BUNDLE_CONTENT_TYPE
  if (written === 0 && (response.status === 404 || (response.ok && !isBundle))) {
    await response.body?.cancel()
    return 'no-route'
  }
  const isContinued = written === 0 || response.headers.get('content-range') === `bytes ${written}-${transfer.size - 1}/${transfer.size}`
  if (response.status !== (written > 0 ? 206 : 200) || !isBundle || !isContinued || !response.body) {
    await response.body?.cancel()
    throw new BundleStreamRefused(`The host answered the bundle stream with HTTP ${response.status}, not the bytes from ${written}.`)
  }
  return response.body
}

/** A stream that continuing cannot correct. */
class BundleStreamRefused extends Error {}

async function readChunks(remote: RemoteHost, transferId: string, size: number, file: FileHandle, signal: AbortSignal): Promise<void> {
  for (let offset = 0; offset < size;) {
    signal.throwIfAborted()
    const chunk = await remote.call('session repository bundle chunk', () => remote.api.sessionRepositoryBundleChunk({ transferId, offset }))
    const bytes = Buffer.from(chunk.data, 'base64')
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES || offset + bytes.length > size) throw new Error('Invalid bundle chunk size.')
    await file.write(bytes, 0, bytes.length, offset)
    offset += bytes.length
    if (chunk.done !== (offset === size)) throw new Error('Bundle ended at the wrong size.')
  }
}
