import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'
import { SvelteSet } from 'svelte/reactivity'
import type {
  GithubPublishRepositoryRequest,
  GithubPublishRepositoryResult,
  GitRepositoryStatus,
  IpcContext,
} from '../../../shared/types'

/**
 * Renderer authority for "Initialize Git" and "Publish to GitHub" — the
 * non-repository / no-primary-remote empty states. Keyed by host + cwd so two
 * tabs pointed at different projects never share loading or error state.
 */
export class RepositorySetupStore {
  private statusByKey = $state<Record<string, GitRepositoryStatus | null>>({})
  private inflight = new Map<string, Promise<GitRepositoryStatus | null>>()
  private initializingKeys = new SvelteSet<string>()
  private publishingKeys = new SvelteSet<string>()
  private initErrorByKey = $state<Record<string, string | null>>({})
  private publishErrorByKey = $state<Record<string, string | null>>({})
  private publishResultByKey = $state<Record<string, GithubPublishRepositoryResult | null>>({})

  statusFor(serverId: string, cwd: string): GitRepositoryStatus | null | undefined {
    return this.statusByKey[hostKey(serverId, cwd)]
  }

  isInitializing(serverId: string, cwd: string): boolean {
    return this.initializingKeys.has(hostKey(serverId, cwd))
  }

  isPublishing(serverId: string, cwd: string): boolean {
    return this.publishingKeys.has(hostKey(serverId, cwd))
  }

  initErrorFor(serverId: string, cwd: string): string | null {
    return this.initErrorByKey[hostKey(serverId, cwd)] ?? null
  }

  publishErrorFor(serverId: string, cwd: string): string | null {
    return this.publishErrorByKey[hostKey(serverId, cwd)] ?? null
  }

  lastPublishResultFor(serverId: string, cwd: string): GithubPublishRepositoryResult | null {
    return this.publishResultByKey[hostKey(serverId, cwd)] ?? null
  }

  async refresh(api: HostApi, serverId: string, cwd: string): Promise<GitRepositoryStatus | null> {
    const key = hostKey(serverId, cwd)
    const existing = this.inflight.get(key)
    if (existing) return existing
    const pending = api.gitRepositoryStatus(cwd)
      .then((status) => {
        this.statusByKey[key] = status
        return status
      })
      .catch(() => this.statusByKey[key] ?? null)
      .finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key)
      })
    this.inflight.set(key, pending)
    return pending
  }

  async initialize(api: HostApi, serverId: string, cwd: string): Promise<boolean> {
    const key = hostKey(serverId, cwd)
    if (this.initializingKeys.has(key)) return false
    this.initializingKeys.add(key)
    this.initErrorByKey[key] = null
    try {
      await api.gitInitRepository(cwd)
      await this.refresh(api, serverId, cwd)
      return true
    } catch (err) {
      this.initErrorByKey[key] = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      this.initializingKeys.delete(key)
    }
  }

  async publish(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    cwd: string,
    request: GithubPublishRepositoryRequest,
  ): Promise<GithubPublishRepositoryResult | null> {
    const key = hostKey(serverId, cwd)
    if (this.publishingKeys.has(key)) return null
    this.publishingKeys.add(key)
    this.publishErrorByKey[key] = null
    try {
      const result = await api.githubPublishRepository(ctx, request)
      this.publishResultByKey[key] = result
      await this.refresh(api, serverId, cwd)
      return result
    } catch (err) {
      this.publishErrorByKey[key] = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      this.publishingKeys.delete(key)
    }
  }

  clearPublishResult(serverId: string, cwd: string): void {
    const key = hostKey(serverId, cwd)
    this.publishResultByKey[key] = null
    this.publishErrorByKey[key] = null
  }
}

export const repositorySetupStore = new RepositorySetupStore()
