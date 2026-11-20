import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/database'
import { dataDir } from '../../platform/paths'
import { sessionRepositories } from '../../data/sessions/schema'
import { ArtifactsRepositoryProvider } from '../git-storage/artifacts-repository-provider'
import { LocalGitRepositoryProvider } from '../git-storage/local-git-repository-provider'
import type { RepositoryProvider } from '../git-storage/repository-provider'

/** The cloud storage of session repositories that `SOLUS_SESSION_STORAGE` names. The record service owns credentials; hosts receive a single repository token. */
export async function sessionRemoteProvider(db: Db, env: NodeJS.ProcessEnv = process.env, requestFetch: typeof fetch = fetch): Promise<RepositoryProvider | null> {
  const kind = env.SOLUS_SESSION_STORAGE ?? 'off'
  if (kind === 'off') return null
  if (kind !== 'cloudflare-artifacts' && kind !== 'local-git') throw new Error(`Invalid SOLUS_SESSION_STORAGE: ${kind}. Use off, local-git, or cloudflare-artifacts.`)
  const provider = kind === 'cloudflare-artifacts'
    ? ArtifactsRepositoryProvider.fromEnvironment(env, 'SOLUS_SESSION_ARTIFACTS_NAMESPACE', 'Session Artifacts storage', undefined, requestFetch)
    : new LocalGitRepositoryProvider(join(dataDir(), 'sessions', 'cloud-repositories'), 'session')
  const saved = await db.all<{ storage_scope: string }>(sql`SELECT DISTINCT storage_scope FROM ${sessionRepositories}`)
  if (saved.some(row => row.storage_scope !== provider.storageScope)) {
    throw new Error(`The configured ${kind === 'cloudflare-artifacts' ? 'session Artifacts account/namespace' : 'local session repository path'} differs from existing session mappings; migrate explicitly.`)
  }
  return provider
}
