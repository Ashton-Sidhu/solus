import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/database'
import { dataDir } from '../../platform/paths'
import { sessionRepositories } from '../../data/sessions/schema'
import { CloudflareWorkRepositories } from '../works/cloudflare-work-repositories'
import { launchProcess } from '../../cli-env'
import { withUserScope } from '../../vault/acting-scope'

const execute = promisify(execFile)
export interface SessionRemoteProvider {
  storageScope: string
  remote(repository: string, access: 'read' | 'write'): Promise<{ url: string; token: string }>
}

/** The record service owns credentials; hosts receive a single repository token. */
export async function sessionRemoteProvider(db: Db, env: NodeJS.ProcessEnv = process.env, requestFetch: typeof fetch = fetch): Promise<SessionRemoteProvider | null> {
  const kind = env.SOLUS_SESSION_STORAGE ?? 'off'
  if (kind === 'off') return null
  if (kind === 'cloudflare-artifacts') {
    const accountId = env.SOLUS_ARTIFACTS_ACCOUNT_ID
    const namespace = env.SOLUS_SESSION_ARTIFACTS_NAMESPACE
    const credential = env.SOLUS_ARTIFACTS_API_TOKEN
    if (!accountId || !namespace || !credential) throw new Error('Session Artifacts storage needs SOLUS_ARTIFACTS_ACCOUNT_ID, SOLUS_SESSION_ARTIFACTS_NAMESPACE and SOLUS_ARTIFACTS_API_TOKEN.')
    const storageScope = `${accountId}/${namespace}`
    const saved = await db.all<{ storage_scope: string }>(sql`SELECT DISTINCT storage_scope FROM ${sessionRepositories}`)
    if (saved.some(row => row.storage_scope !== storageScope)) throw new Error('The configured session Artifacts account/namespace differs from existing session mappings; migrate explicitly.')
    const cloud = new CloudflareWorkRepositories(accountId, namespace, credential, undefined, requestFetch)
    return { storageScope, remote: (repository, access) => cloud.remote(repository, access) }
  }
  if (kind === 'local-git') {
    const root = join(dataDir(), 'sessions', 'cloud-repositories')
    const storageScope = `file://${root}`
    const saved = await db.all<{ storage_scope: string }>(sql`SELECT DISTINCT storage_scope FROM ${sessionRepositories}`)
    if (saved.some(row => row.storage_scope !== storageScope)) throw new Error('The configured local session repository path differs from existing session mappings; migrate explicitly.')
    return { storageScope, async remote(repository) {
      if (!/^session-[a-f0-9]{48}$/.test(repository)) throw new Error('Invalid session repository name.')
      const path = join(root, `${repository}.git`)
      await mkdir(root, { recursive: true, mode: 0o700 })
      await withUserScope(null, async () => {
        const command = launchProcess('git', ['init', '--bare', '--initial-branch=main', path], { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' })
        await execute(command.file, command.args, { timeout: 30_000, env: command.env })
      })
      return { url: pathToFileURL(path).href, token: '' }
    } }
  }
  throw new Error(`Invalid SOLUS_SESSION_STORAGE: ${kind}. Use off, local-git, or cloudflare-artifacts.`)
}
