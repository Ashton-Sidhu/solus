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
  /** Revision lists in flight, so the cards of one work in one page share a read. */
  private listReads = new Map<string, Promise<WorkRevisionSummary[]>>()

  /** `ask` runs a read on the host that has the work now. `likelyServerId`
   *  names where to ask when this client has not listed the work yet. */
  constructor(private ask: <T>(workId: string, read: (api: HostApi) => Promise<T>, likelyServerId?: string) => Promise<T>) {}

  async load(workId: string): Promise<void> {
    const token = (this.tokens.get(workId) ?? 0) + 1
    this.tokens.set(workId, token)
    try {
      const revisions = await this.ask(workId, (api) => api.loadWorkRevisions(workId))
      if (this.tokens.get(workId) !== token) return
      this.revisions.set(workId, revisions)
      this.errors.delete(workId)
    } catch (error) {
      if (this.tokens.get(workId) === token) this.errors.set(workId, error instanceof Error ? error.message : String(error))
    }
  }

  /** One checkpoint's body. A failed read is not cached, so a retry asks again. */
  body(workId: string, revisionId: number, likelyServerId?: string): Promise<string> {
    const key = `${workId}:${revisionId}`
    const cached = this.bodies.get(key)
    if (cached) return cached
    const read = this.ask(workId, (api) => api.loadWorkRevision(workId, revisionId), likelyServerId).then((revision) => revision.content)
    this.bodies.set(key, read)
    read.catch(() => this.bodies.delete(key))
    return read
  }

  /** The body the work had at `contentVersion`; null when no checkpoint holds it.
   *  `likelyServerId` is the host the work was probably made on — a transcript
   *  card's session host — so a card does not wait for every host's work list. */
  async bodyAtVersion(workId: string, contentVersion: number, likelyServerId?: string): Promise<string | null> {
    let list = this.listReads.get(workId)
    if (!list) {
      list = this.ask(workId, (api) => api.loadWorkRevisions(workId), likelyServerId)
      this.listReads.set(workId, list)
      void list.finally(() => this.listReads.delete(workId)).catch(() => {})
    }
    const revision = (await list).find((entry) => entry.sourceContentVersion === contentVersion)
    return revision ? this.body(workId, revision.revisionId, likelyServerId) : null
  }

  forget(workId: string): void {
    this.revisions.delete(workId)
    this.errors.delete(workId)
    this.tokens.delete(workId)
    for (const key of this.bodies.keys()) if (key.startsWith(`${workId}:`)) this.bodies.delete(key)
  }
}
