import { z } from 'zod'
import type { WorkRepositoryAccess } from './git-work-transport'

const repositorySchema = z.object({ success: z.literal(true), result: z.object({ remote: z.string().url() }) })
const tokenSchema = z.object({ success: z.literal(true), result: z.object({ plaintext: z.string().min(1) }) })

/** Account credentials remain in this server-side control-plane client only. */
export class CloudflareWorkRepositories implements WorkRepositoryAccess {
  private readonly base: string
  constructor(private readonly accountId: string, namespace: string, private readonly apiToken: string, private readonly signal?: AbortSignal) {
    if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]*$/.test(namespace) || !apiToken) throw new Error('Invalid Artifacts account, namespace or server credential.')
    this.base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces/${namespace}`
  }

  private async request(path: string, method = 'GET', body?: string): Promise<Response> {
    const init: RequestInit = {
      method, headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }
    if (method !== 'GET' && body !== undefined) init.body = body
    return fetch(`${this.base}${path}`, init)
  }

  private checkName(repository: string): void {
    if (!/^work-[a-f0-9]{48}$/.test(repository)) throw new Error('Invalid Solus work repository name.')
  }

  async remote(repository: string): Promise<{ url: string; token: string }> {
    this.checkName(repository)
    let response = await this.request(`/repos/${repository}`)
    if (response.status === 404) {
      response = await this.request('/repos', 'POST', JSON.stringify({ name: repository, default_branch: 'main' }))
      if (response.status === 409) response = await this.request(`/repos/${repository}`)
    }
    if (!response.ok) throw new Error('The Artifacts repository could not be opened.')
    const url = repositorySchema.parse(await response.json()).result.remote
    const remote = new URL(url)
    if (remote.protocol !== 'https:' || remote.hostname !== `${this.accountId}.artifacts.cloudflare.net` || remote.username || remote.password || remote.search || remote.hash) throw new Error('Unexpected Artifacts Git remote.')
    const issued = await this.request('/tokens', 'POST', JSON.stringify({ repo: repository, scope: 'write', ttl: 900 }))
    if (!issued.ok) throw new Error('The Artifacts repository token could not be issued.')
    return { url, token: tokenSchema.parse(await issued.json()).result.plaintext }
  }

  async readFile(repository: string, commit: string, path: string): Promise<string> {
    this.checkName(repository)
    const response = await this.request(`/repos/${repository}/file?${new URLSearchParams({ ref: commit, path })}`)
    if (!response.ok) throw new Error('The Artifacts work body could not be read.')
    return response.text()
  }

  async remove(repository: string): Promise<void> {
    this.checkName(repository)
    const response = await this.request(`/repos/${repository}`, 'DELETE')
    if (!response.ok && response.status !== 404) throw new Error('The Artifacts work repository could not be removed.')
    if ((await this.request(`/repos/${repository}`)).status !== 404) throw new Error('The Artifacts work repository deletion was not confirmed.')
  }
}
