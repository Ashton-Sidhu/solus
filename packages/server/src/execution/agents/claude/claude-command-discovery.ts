import type { AgentSlashCommand } from '@solus/contracts/types'
import { MemoryCache } from '@solus/contracts/cache'

export interface ClaudeCommandDiscoveryTarget {
  cwd: string
  model: string | null
}

/**
 * Claude exposes built-in commands only through a short-lived streaming query.
 * Cache identical requests and serialize distinct ones so restoring several
 * worktrees cannot start several Claude subprocesses at once.
 */
export class ClaudeCommandDiscovery {
  private cache: MemoryCache<string, Promise<AgentSlashCommand[]>>
  private queueTail = Promise.resolve()

  constructor(
    private load: (target: ClaudeCommandDiscoveryTarget) => Promise<AgentSlashCommand[]>,
    ttlMs: number,
  ) {
    this.cache = new MemoryCache({ ttlMs, maxEntries: 64 })
  }

  get(target: ClaudeCommandDiscoveryTarget): Promise<AgentSlashCommand[]> {
    const key = JSON.stringify([target.cwd, target.model])
    const cached = this.cache.get(key)
    if (cached) return cached

    const promise = this.enqueue(() => this.load(target)).catch((error) => {
      if (this.cache.get(key) === promise) this.cache.delete(key)
      throw error
    })
    this.cache.set(key, promise)
    return promise
  }

  clear(): void {
    this.cache.clear()
  }

  private enqueue(load: () => Promise<AgentSlashCommand[]>): Promise<AgentSlashCommand[]> {
    const result = this.queueTail.then(load, load)
    this.queueTail = result.then(() => {}, () => {})
    return result
  }
}
