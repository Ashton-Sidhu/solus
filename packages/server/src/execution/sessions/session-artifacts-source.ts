import { createWriteStream, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import type { SessionRepositoryTokenResponse } from '@solus/contracts/session-repositories'
import type { Actor } from '../../admission/actor'
import { GitRemote } from '../../sync/git-storage/git-remote'
import { fileDigest, SessionRepository } from '../../sync/sessions/session-repository'
import { SessionSyncError, type SessionSource, type SessionSourceRequest, type SourceBundle } from './session-sync'

export type SessionReadAccess = (sessionId: string, actor: Actor, signal: AbortSignal) => Promise<SessionRepositoryTokenResponse | null>
/** A signed read URL of one code bundle of the session; null when Solus Cloud has none. */
export type SessionCodeReadUrl = (request: { sessionId: string; sha256: string; bytes: number }, actor: Actor, signal: AbortSignal) => Promise<string | null>
const CLOUD_CATCH_UP_MS = 15_000

/** The cloud source. A failed cloud fetch gives no copy, so the host path is tried. A missing or changed code bundle fails the sync (docs/plans/session-storage.md §7). */
function tryCloud(cloud: SessionSource, request: SessionSourceRequest): Promise<SourceBundle> {
  return cloud(request).catch((error) => {
    if (error instanceof SessionSyncError && error.reason === 'code-restore') throw error
    return { state: 'no-repository' as const }
  })
}

/** Prefer the cloud copy; a missing wanted turn comes from the last run host. */
export async function chooseSessionRepositorySource(
  cloud: SessionSource | null,
  host: SessionSource,
  request: SessionSourceRequest,
): Promise<SourceBundle> {
  const { wantedHead, signal } = request
  if (cloud) {
    const result = await tryCloud(cloud, request)
    if (result.state !== 'no-repository') return result
  }
  try {
    return await host(request)
  } catch (error) {
    if (!cloud || !wantedHead || !(error instanceof SessionSyncError) || error.reason !== 'source-offline') throw error
    const deadline = Date.now() + CLOUD_CATCH_UP_MS
    while (Date.now() < deadline) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, Math.min(500, deadline - Date.now()))
        const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      signal.throwIfAborted()
      const result = await tryCloud(cloud, request)
      if (result.state !== 'no-repository') return result
    }
    throw error
  }
}

/**
 * Fetch a cloud copy into a disposable bare repository, with the code bundles
 * that its manifest names (docs/plans/session-storage.md §7). The caller
 * removes its parent directory.
 */
export async function fetchSessionArtifacts(
  getReadAccess: SessionReadAccess,
  getCodeUrl: SessionCodeReadUrl,
  localRepositoryPath: string | null,
  request: SessionSourceRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceBundle> {
  const { sessionId, actor, have, wantedHead, outFile, signal } = request
  const access = await getReadAccess(sessionId, actor, signal)
  if (!access) return { state: 'no-repository' }
  const repositoryPath = `${outFile}.git`
  const remote = await GitRemote.open({ gitDir: repositoryPath, remote: access.remote, token: access.token || undefined, signal,
    timeoutMs: 10 * 60_000, outputLimitBytes: 1024 * 1024 })
  try {
    const copy = remote.repository
    await copy.init()
    if (localRepositoryPath && existsSync(join(localRepositoryPath, 'objects'))) await copy.borrowObjects(localRepositoryPath)
    const head = await remote.remoteHead()
    if (!head) return { state: 'no-repository' }
    if (head === have && (!wantedHead || wantedHead === head)) return { state: 'current' }
    await copy.fetchMain(access.remote)
    if (have && !await copy.isAncestor(have, head)) return { state: 'diverged' }
    if (wantedHead && !await copy.isAncestor(wantedHead, head)) return { state: 'no-repository' }
    await copy.setHead(head)
    const local = localRepositoryPath && existsSync(localRepositoryPath) ? new SessionRepository(localRepositoryPath, signal) : null
    await fetchCodeBundles(getCodeUrl, new SessionRepository(repositoryPath, signal), local, head, request, fetchImpl)
    return { state: 'ready', repositoryPath, head, source: 'cloud' }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SessionSyncError) throw error
    throw new SessionSyncError('source-offline', error instanceof Error ? error.message : 'Cloud repository fetch failed.')
  } finally {
    await remote.close()
  }
}

/** Download each stored code bundle of the manifest at `head` that neither copy has, and keep it under its code ref. */
async function fetchCodeBundles(
  getCodeUrl: SessionCodeReadUrl,
  copy: SessionRepository,
  local: SessionRepository | null,
  head: string,
  { sessionId, actor, outFile, signal }: SessionSourceRequest,
  fetchImpl: typeof fetch,
): Promise<void> {
  const file = `${outFile}.code`
  for (const { bundle } of (await copy.readManifest(head)).turns) {
    if (bundle?.kind !== 'stored' || await copy.hasCodeBundle(bundle.sha256) || await local?.hasCodeBundle(bundle.sha256)) continue
    const url = await getCodeUrl({ sessionId, sha256: bundle.sha256, bytes: bundle.bytes }, actor, signal)
    if (!url) throw new SessionSyncError('code-restore', 'A session code bundle is not in Solus Cloud.')
    const response = await fetchImpl(url, { signal })
    if (response.status === 404) throw new SessionSyncError('code-restore', 'A session code bundle is not in Solus Cloud.')
    if (!response.ok || !response.body) throw new Error(`Code bundle download failed (${response.status}).`)
    let received = 0
    const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      done(received > bundle.bytes ? new SessionSyncError('code-restore', 'A session code bundle is larger than its manifest.') : null, chunk)
    } })
    try {
      // SAFETY: the body of a `fetch` answer is a web stream of bytes, which Node reads as this type.
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), limit, createWriteStream(file))
      const digest = await fileDigest(file)
      if (digest.bytes !== bundle.bytes || digest.sha256 !== bundle.sha256) throw new SessionSyncError('code-restore', 'A session code bundle does not match its manifest.')
      await copy.storeCodeBundle(file)
    } finally {
      await rm(file, { force: true })
    }
  }
}
