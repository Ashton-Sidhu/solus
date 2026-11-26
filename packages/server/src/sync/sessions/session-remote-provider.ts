import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/database'
import { dataDir } from '../../platform/paths'
import { getAssetSigningSecret } from '../../admission/signed-token'
import { sessionRepositories } from '../../data/sessions/schema'
import { ArtifactsRepositoryProvider } from '../git-storage/artifacts-repository-provider'
import { LocalGitRepositoryProvider } from '../git-storage/local-git-repository-provider'
import { LocalObjectStore } from '../git-storage/local-object-store'
import type { ObjectStore } from '../git-storage/object-store'
import { R2ObjectStore } from '../git-storage/r2-object-store'
import type { RepositoryProvider } from '../git-storage/repository-provider'

/** Where the session repositories and their code bundles are. One switch makes both (docs/plans/session-storage.md decision 10). */
export interface SessionRemoteStorage {
  repositories: RepositoryProvider
  code: ObjectStore
}

/**
 * The cloud storage of session repositories that `SOLUS_SESSION_STORAGE` names. The record service owns credentials;
 * hosts receive a single repository token or a URL for one object. `cloudflare-artifacts` needs both Artifacts and R2:
 * a missing setting stops the startup.
 */
export async function sessionRemoteProvider(db: Db, env: NodeJS.ProcessEnv = process.env, requestFetch: typeof fetch = fetch): Promise<SessionRemoteStorage | null> {
  const kind = env.SOLUS_SESSION_STORAGE ?? 'off'
  if (kind === 'off') return null
  if (kind !== 'cloudflare-artifacts' && kind !== 'local-git') throw new Error(`Invalid SOLUS_SESSION_STORAGE: ${kind}. Use off, local-git, or cloudflare-artifacts.`)
  const storage: SessionRemoteStorage = kind === 'cloudflare-artifacts'
    ? {
      repositories: ArtifactsRepositoryProvider.fromEnvironment(env, 'SOLUS_SESSION_ARTIFACTS_NAMESPACE', 'Session Artifacts storage', undefined, requestFetch),
      code: R2ObjectStore.fromEnvironment(env),
    }
    : {
      repositories: new LocalGitRepositoryProvider(join(dataDir(), 'sessions', 'cloud-repositories'), 'session'),
      code: new LocalObjectStore(join(dataDir(), 'sessions', 'cloud-code'), getAssetSigningSecret()),
    }
  const saved = await db.all<{ storage_scope: string }>(sql`SELECT DISTINCT storage_scope FROM ${sessionRepositories}`)
  if (saved.some(row => row.storage_scope !== storage.repositories.storageScope)) {
    throw new Error(`The configured ${kind === 'cloudflare-artifacts' ? 'session Artifacts account/namespace' : 'local session repository path'} differs from existing session mappings; migrate explicitly.`)
  }
  return storage
}
