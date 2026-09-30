import { SvelteMap } from 'svelte/reactivity'
import type { WorkRevisionSummary } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'

/**
 * A work's checkpoints, read from its owner host. The list is refreshed each
 * time a reader opens History. A checkpoint is immutable and keeps its id
 * across Share, so a body read once is cached for good.
 */
export class WorkHistoryStore {
  readonly revisions = new SvelteMap<string, WorkRevisionSummary[]>()
  readonly errors = new SvelteMap<string, string>()
  private tokens = new Map<string, number>()
  private bodies = new Map<string, Promise<string>>()

  constructor(private api: (workId: string) => HostApi) {}

  async load(workId: string): Promise<void> {
    const token = (this.tokens.get(workId) ?? 0) + 1
    this.tokens.set(workId, token)
    try {
      const revisions = await this.api(workId).loadWorkRevisions(workId)
      if (this.tokens.get(workId) !== token) return
      this.revisions.set(workId, revisions)
      this.errors.delete(workId)
    } catch (error) {
      if (this.tokens.get(workId) === token) this.errors.set(workId, error instanceof Error ? error.message : String(error))
    }
  }

  /** One checkpoint's body. A failed read is not cached, so a retry asks again. */
  body(workId: string, revisionId: number): Promise<string> {
    const key = `${workId}:${revisionId}`
    const cached = this.bodies.get(key)
    if (cached) return cached
    const read = this.api(workId).loadWorkRevision(workId, revisionId).then((revision) => revision.content)
    this.bodies.set(key, read)
    read.catch(() => this.bodies.delete(key))
    return read
  }

  forget(workId: string): void {
    this.revisions.delete(workId)
    this.errors.delete(workId)
    this.tokens.delete(workId)
    for (const key of this.bodies.keys()) if (key.startsWith(`${workId}:`)) this.bodies.delete(key)
  }
}
