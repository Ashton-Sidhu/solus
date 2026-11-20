import { open } from 'node:fs/promises'
import type { RemoteHosts, ReachRequest } from '../orchestration/remote-hosts'
import { SessionSyncError, type SessionSourceRequest, type SourceBundle } from './session-sync'

const CHUNK_BYTES = 1024 * 1024

/** The last run host as a source: its copy comes over bounded RPC calls. */
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
      for (let offset = 0; offset < answer.size;) {
        signal.throwIfAborted()
        const chunk = await remote.call('session repository bundle chunk', () => remote.api.sessionRepositoryBundleChunk({ transferId: answer.transferId, offset }))
        const bytes = Buffer.from(chunk.data, 'base64')
        if (bytes.length === 0 || bytes.length > CHUNK_BYTES || offset + bytes.length > answer.size) throw new Error('Invalid bundle chunk size.')
        await file.write(bytes, 0, bytes.length, offset)
        offset += bytes.length
        if (chunk.done !== (offset === answer.size)) throw new Error('Bundle ended at the wrong size.')
      }
    } finally {
      await file.close()
    }
    return { state: 'ready', repositoryPath: outFile, head: answer.head, source: 'host' }
  } catch (error) {
    signal.throwIfAborted()
    throw new SessionSyncError('source-offline', `${target.label} is offline or its session bundle could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}
