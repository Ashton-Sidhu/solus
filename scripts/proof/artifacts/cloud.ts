import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { GitRemote } from './process'

const credentials = z.object({ oauth_token: z.string().min(1) })
const created = z.object({ name: z.string(), remote: z.string().url(), token: z.string().min(1) })

/** Only disposable repos owned by this run can be deleted. No tokens enter reports. */
export class ArtifactsCloud {
  private readonly repos = new Set<string>()
  operations = 0
  constructor(readonly accountId: string, readonly namespace: string, readonly prefix: string, private readonly token: string) {
    if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Set CLOUDFLARE_ACCOUNT_ID explicitly to a valid account id')
    if (!/^solus-proof-[a-z0-9-]+$/.test(prefix)) throw new Error('A unique solus-proof- resource prefix is required')
  }
  static async fromWrangler(accountId: string, prefix: string): Promise<ArtifactsCloud> {
    const token = process.env.CLOUDFLARE_API_TOKEN ?? credentials.parse(Bun.TOML.parse(await readFile(join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'), 'utf8'))).oauth_token
    return new ArtifactsCloud(accountId, 'solus-artifacts-proof', prefix, token)
  }
  static async fromCf(accountId: string, prefix: string): Promise<ArtifactsCloud> {
    const token = credentials.parse(JSON.parse(await readFile(join(homedir(), 'Library/Preferences/cloudflare/config/default.json'), 'utf8'))).oauth_token
    return new ArtifactsCloud(accountId, 'default', prefix, token)
  }
  private async request(path: string, method = 'GET', body?: string): Promise<Response> {
    this.operations += 1
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000) }
    if (method !== 'GET' && body !== undefined) init.body = body
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/artifacts/namespaces/${this.namespace}${path}`, init)
    if (!response.ok) throw new Error(`Artifacts ${method} ${path} returned HTTP ${response.status}`)
    return response
  }
  async create(suffix: string): Promise<GitRemote & { name: string }> {
    const name = `${this.prefix}-${suffix}`
    // Record before the request: a lost response must not leave an untracked repo.
    this.repos.add(name)
    const response = await this.request('/repos', 'POST', JSON.stringify({ name, default_branch: 'main', description: 'Disposable Solus Artifacts proof; contains synthetic fixtures only' }))
    const result = z.object({ success: z.literal(true), result: created }).parse(await response.json()).result
    if (result.name !== name) throw new Error('Created repo name does not match this run')
    return { name, url: result.remote, token: result.token }
  }
  async readFile(name: string, ref: string, path: string): Promise<string> {
    if (!this.repos.has(name)) throw new Error('This run does not own the repo')
    const response = await this.request(`/repos/${name}/file?${new URLSearchParams({ ref, path })}`)
    return response.text()
  }
  async issueToken(name: string, scope: 'read' | 'write'): Promise<string> {
    if (!this.repos.has(name)) throw new Error('This run does not own the repo')
    const response = await this.request('/tokens', 'POST', JSON.stringify({ repo: name, scope, ttl: 900 }))
    return z.object({ success: z.literal(true), result: z.object({ plaintext: z.string().min(1) }) }).parse(await response.json()).result.plaintext
  }
  registerFork(parent: string): void {
    if (!this.repos.has(parent)) throw new Error('This run does not own the parent repo')
    this.repos.add(`${parent}-fork`)
  }
  async cleanup(): Promise<string[]> {
    const errors: string[] = []
    for (const name of this.repos) {
      try {
        const current = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/artifacts/namespaces/${this.namespace}/repos/${name}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) })
        if (current.status === 404) continue
        if (!current.ok) throw new Error(`Cleanup preflight returned ${current.status}`)
        await this.request(`/repos/${name}`, 'DELETE')
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/artifacts/namespaces/${this.namespace}/repos/${name}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) })
        if (response.status !== 404) throw new Error(`Deletion verification returned ${response.status}`)
      } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return errors
  }
}
