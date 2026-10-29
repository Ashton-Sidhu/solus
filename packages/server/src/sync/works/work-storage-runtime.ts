import { withUserScope } from '../../vault/acting-scope'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/database'
import { dataDir } from '../../platform/paths'
import { workStorage } from '../../data/works/schema'
import { databaseWorkStorage } from '../../data/works/database-work-storage'
import { installWorkStorage, workStorageProviderSchema } from '../../data/works/work-storage'
import { GitWorkStorage } from '../../data/works/git-work-storage'
import { GitWorkTransport } from './git-work-transport'
import { CloudflareWorkRepositories } from './cloudflare-work-repositories'
import { LocalWorkRepositories } from './local-work-repositories'
import { migrateLocalWorkHistory } from './local-work-migration'
import { WorkArchiveWriter } from './work-archive-writer'

export interface WorkStorageEnvironment {
  SOLUS_WORK_STORAGE?: string
  SOLUS_ARTIFACTS_ACCOUNT_ID?: string
  SOLUS_ARTIFACTS_NAMESPACE?: string
  SOLUS_ARTIFACTS_API_TOKEN?: string
}

/** Local works use offline Git. The cloud setting chooses new organization records only. */
export async function startWorkStorage(input: {
  database: () => Db
  cloud: boolean
  flushLive: (workId: string) => Promise<void>
  env?: WorkStorageEnvironment
}): Promise<{ stop: () => Promise<void> }> {
  const env = input.env ?? process.env
  const provider = workStorageProviderSchema.parse(env.SOLUS_WORK_STORAGE ?? (input.cloud ? 'database' : 'local-git'))
  if (!input.cloud && provider === 'cloudflare-artifacts') throw new Error('Artifacts work storage is configured on the cloud record service, not a local host.')
  const existing = z.object({ count: z.coerce.number() }).parse(await input.database().get(sql`SELECT COUNT(*) AS count FROM ${workStorage} WHERE provider = 'cloudflare-artifacts'`))
  const abort = new AbortController()
  const writers: WorkArchiveWriter[] = []
  const localTransport = new GitWorkTransport(new LocalWorkRepositories(join(dataDir(), 'works', 'history'), abort.signal), abort.signal)
  const localWriter = new WorkArchiveWriter(input.database, localTransport, Date.now, input.flushLive, 'local-git')
  const localGit = new GitWorkStorage(localTransport, workId => localWriter.drain(workId), Date.now, 'local', 'local-git')
  writers.push(localWriter)
  let artifacts: GitWorkStorage | undefined
  if (provider === 'cloudflare-artifacts' || existing.count > 0) {
    if (!env.SOLUS_ARTIFACTS_ACCOUNT_ID || !env.SOLUS_ARTIFACTS_NAMESPACE || !env.SOLUS_ARTIFACTS_API_TOKEN) throw new Error('Artifacts work storage needs SOLUS_ARTIFACTS_ACCOUNT_ID, SOLUS_ARTIFACTS_NAMESPACE and SOLUS_ARTIFACTS_API_TOKEN.')
    const storageScope = `${env.SOLUS_ARTIFACTS_ACCOUNT_ID}/${env.SOLUS_ARTIFACTS_NAMESPACE}`
    const scopes = z.object({ storage_scope: z.string().nullable() }).array().parse(await input.database().all(sql`SELECT DISTINCT storage_scope FROM ${workStorage} WHERE provider = 'cloudflare-artifacts'`))
    if (scopes.some(row => row.storage_scope !== storageScope)) throw new Error('The configured Artifacts account/namespace differs from existing work mappings; migrate explicitly.')
    const repositories = new CloudflareWorkRepositories(env.SOLUS_ARTIFACTS_ACCOUNT_ID, env.SOLUS_ARTIFACTS_NAMESPACE, env.SOLUS_ARTIFACTS_API_TOKEN, abort.signal)
    const transport = new GitWorkTransport(repositories, abort.signal)
    const writer = new WorkArchiveWriter(input.database, transport, Date.now, input.flushLive)
    artifacts = new GitWorkStorage(transport, workId => writer.drain(workId), Date.now, storageScope)
    writers.push(writer)
  }
  const restore = installWorkStorage({ database: databaseWorkStorage, localGit, artifacts, defaultProvider: provider })
  let running: Promise<void> | null = null
  const tick = () => {
    if (running) return
    running = withUserScope(null, async () => {
      if (!input.cloud) await migrateLocalWorkHistory(input.database, localGit)
      for (const writer of writers) await writer.runDue()
    }).catch(() => {}).finally(() => { running = null })
  }
  const timer = setInterval(tick, 1_000)
  timer.unref()
  tick()
  return {
    stop: async () => {
      clearInterval(timer)
      abort.abort()
      await running
      await Promise.all(writers.map(writer => writer.idle()))
      restore()
    },
  }
}
