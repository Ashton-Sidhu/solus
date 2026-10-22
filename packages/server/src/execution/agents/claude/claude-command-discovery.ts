import type { AgentSlashCommand } from '@solus/contracts/types'
import { MemoryCache } from '@solus/contracts/cache'
import type { ClaudeSeat } from './claude-agent'

export interface ClaudeCommandDiscoveryTarget {
  cwd: string
  model: string | null
  /** Whose CLI reports the commands: their skills and plugins are among them. Absent: the host's. */
  seat?: ClaudeSeat
  /** The seat's config folder: two people on one host never share a list. */
  configDir: string
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
    const key = JSON.stringify([target.cwd, target.model, target.configDir])
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
