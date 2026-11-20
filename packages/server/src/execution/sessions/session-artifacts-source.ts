import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionRepositoryTokenResponse } from '@solus/contracts/session-repositories'
import type { Actor } from '../../admission/actor'
import { GitRemote } from '../../sync/git-remote'
import { SessionSyncError, type SessionSource, type SessionSourceRequest, type SourceBundle } from './session-sync'

export type SessionReadAccess = (sessionId: string, actor: Actor, signal: AbortSignal) => Promise<SessionRepositoryTokenResponse | null>
const CLOUD_CATCH_UP_MS = 15_000

/** Prefer the cloud copy; a missing wanted turn comes from the last run host. */
export async function chooseSessionRepositorySource(
  cloud: SessionSource | null,
  host: SessionSource,
  request: SessionSourceRequest,
): Promise<SourceBundle> {
  const { wantedHead, signal } = request
  if (cloud) {
    const result = await cloud(request).catch(() => ({ state: 'no-repository' as const }))
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
      const result = await cloud(request).catch(() => ({ state: 'no-repository' as const }))
      if (result.state !== 'no-repository') return result
    }
    throw error
  }
}

/** Fetch a cloud copy into a disposable bare repository. The caller removes its parent directory. */
export async function fetchSessionArtifacts(
  getReadAccess: SessionReadAccess,
  localRepositoryPath: string | null,
  { sessionId, actor, have, wantedHead, outFile, signal }: SessionSourceRequest,
): Promise<SourceBundle> {
  const access = await getReadAccess(sessionId, actor, signal)
  if (!access) return { state: 'no-repository' }
  const repositoryPath = `${outFile}.git`
  await mkdir(repositoryPath, { recursive: true, mode: 0o700 })
  const remote = await GitRemote.open({ gitDir: repositoryPath, remote: access.remote, token: access.token || undefined, signal,
    timeoutMs: 10 * 60_000, outputLimitBytes: 1024 * 1024 })
  try {
    await remote.git(['init', '--bare', '--initial-branch=main'])
    if (localRepositoryPath && existsSync(join(localRepositoryPath, 'objects'))) {
      await mkdir(join(repositoryPath, 'objects', 'info'), { recursive: true })
      await writeFile(join(repositoryPath, 'objects', 'info', 'alternates'), `${join(localRepositoryPath, 'objects')}\n`)
    }
    const head = await remote.remoteHead()
    if (!head) return { state: 'no-repository' }
    if (head === have && (!wantedHead || wantedHead === head)) return { state: 'current' }
    await remote.git(['fetch', access.remote, 'refs/heads/main'])
    if (have && !await remote.git(['merge-base', '--is-ancestor', have, head]).then(() => true, () => false)) return { state: 'diverged' }
    if (wantedHead && !await remote.git(['merge-base', '--is-ancestor', wantedHead, head]).then(() => true, () => false)) {
      return { state: 'no-repository' }
    }
    await remote.git(['update-ref', 'refs/heads/main', head])
    return { state: 'ready', repositoryPath, head, source: 'cloud' }
  } catch (error) {
    signal.throwIfAborted()
    throw new SessionSyncError('source-offline', error instanceof Error ? error.message : 'Cloud repository fetch failed.')
  } finally {
    await remote.close()
  }
}
