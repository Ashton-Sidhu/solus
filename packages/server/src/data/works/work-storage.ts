import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/database'
import { documentContentHash } from '../../docs/content-hash'
import { workStorage } from './schema'

export const workStorageProviderSchema = z.enum(['database', 'local-git', 'cloudflare-artifacts'])
export type WorkStorageProvider = z.infer<typeof workStorageProviderSchema>

export interface WorkBodyAddress {
  organizationId: string
  workId: string
  contentHash: string
  /** Null names the current body, otherwise an immutable Solus revision. */
  revisionId: number | null
}

/** Domain rules stay in Work. Captures are transactional; network pushes happen separately. */
export interface WorkStorageAdapter {
  readonly provider: WorkStorageProvider
  readonly storageScope?: string
  read(db: Db, address: WorkBodyAddress, projection: string | null): Promise<string>
  capture(db: Db, address: WorkBodyAddress, content: string): Promise<void>
  changed(db: Db, organizationId: string, workId: string, immediate: boolean): Promise<void>
  remove(db: Db, organizationId: string, workId: string): Promise<void>
  flush(workId: string): Promise<void>
}

export function verifyWorkBody(address: WorkBodyAddress, content: string): string {
  if (documentContentHash(content) !== address.contentHash) throw new Error('Stored work content does not match its hash.')
  return content
}

const mappingSchema = z.object({ provider: workStorageProviderSchema, organization_id: z.string(), storage_scope: z.string().nullable() })
let databaseAdapter: WorkStorageAdapter | null = null
let artifactsAdapter: WorkStorageAdapter | null = null
let localGitAdapter: WorkStorageAdapter | null = null
let defaultProvider: WorkStorageProvider = 'database'

/** Installed by composition, never by a work or by an environment check inside a write. */
export function installWorkStorage(input: { database: WorkStorageAdapter; artifacts?: WorkStorageAdapter; localGit?: WorkStorageAdapter; defaultProvider?: WorkStorageProvider }): () => void {
  if (input.defaultProvider === 'cloudflare-artifacts' && !input.artifacts) throw new Error('Artifacts work storage is not configured.')
  if (input.defaultProvider === 'local-git' && !input.localGit) throw new Error('Local Git work storage is not configured.')
  const previous = { databaseAdapter, artifactsAdapter, localGitAdapter, defaultProvider }
  databaseAdapter = input.database
  artifactsAdapter = input.artifacts ?? null
  localGitAdapter = input.localGit ?? null
  defaultProvider = input.defaultProvider ?? 'database'
  return () => { ({ databaseAdapter, artifactsAdapter, localGitAdapter, defaultProvider } = previous) }
}

export function useDefaultDatabaseWorkStorage(adapter: WorkStorageAdapter): void {
  databaseAdapter ??= adapter
}

export async function storageForWork(db: Db, organizationId: string, workId: string): Promise<WorkStorageAdapter> {
  const mapping = mappingSchema.nullish().parse(await db.get(sql`SELECT provider, organization_id, storage_scope FROM ${workStorage} WHERE work_id = ${workId}`))
  if (mapping && mapping.organization_id !== organizationId) throw new Error('Work storage belongs to another organization.')
  const provider = mapping?.provider ?? 'database' // An old row never inherits a new default.
  const adapter = provider === 'database' ? databaseAdapter : provider === 'local-git' ? localGitAdapter : artifactsAdapter
  if (!adapter) throw new Error(`The ${provider} work storage adapter is not configured.`)
  if (mapping?.provider === 'cloudflare-artifacts' && mapping.storage_scope !== adapter.storageScope) throw new Error('The Artifacts account or namespace differs from this work’s stored mapping.')
  return adapter
}

/** Only creation chooses the default. Local works use offline Git when it is configured. */
export async function initializeWorkStorage(db: Db, organizationId: string, workId: string): Promise<void> {
  const provider = organizationId === 'local' ? (localGitAdapter ? 'local-git' : 'database') : defaultProvider
  const repository = provider === 'database' ? null : `work-${createHash('sha256').update(JSON.stringify([organizationId, workId])).digest('hex').slice(0, 48)}`
  await db.run(sql`INSERT INTO ${workStorage} (work_id, organization_id, provider, repository, storage_scope)
    VALUES (${workId}, ${organizationId}, ${provider}, ${repository}, ${provider === 'cloudflare-artifacts' ? artifactsAdapter?.storageScope : provider === 'local-git' ? 'local' : null})`)
}
