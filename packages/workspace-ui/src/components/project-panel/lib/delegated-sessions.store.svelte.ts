import { SvelteMap } from 'svelte/reactivity'
import type { WorkMeta } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'

/** The ids of the sessions one session sent work to, or null when the host did not answer. */
type ListDelegated = (serverId: string, parentSessionId: string) => Promise<readonly string[] | null>

const listOnHost: ListDelegated = (serverId, parentSessionId) =>
  serverConnections.apiFor(serverId).sessionRecordList({ parentSessionId })
    .then((answer) => answer.records.map((record) => record.sessionId))

/**
 * The sessions each session sent work to, as its host lists them. The
 * Environment card counts their artifacts as the session's
 * (docs/plans/environment-view.md). The host decides which of them the reader
 * may list.
 */
export class DelegatedSessionsStore {
  private readonly delegated = new SvelteMap<string, ReadonlySet<string>>()
  /** Per session, the artifact owners a read already answered for. */
  private readonly answeredOwners = new Map<string, ReadonlySet<string>>()
  private readonly reads = new Set<string>()

  constructor(private readonly listDelegated: ListDelegated = listOnHost) {}

  /** The sessions this session sent work to; undefined until its host answered
   *  once. A host that failed counts as answered, with the sessions read before. */
  delegatedBy(serverId: string, sessionId: string): ReadonlySet<string> | undefined {
    return this.delegated.get(keyOf(serverId, sessionId))
  }

  /**
   * Read the session's delegated sessions once, and again when an artifact
   * names an owner no read answered for: a worker started since the last read.
   */
  ensureRead(serverId: string, sessionId: string, artifactOwners: ReadonlySet<string>): void {
    const key = keyOf(serverId, sessionId)
    if (this.reads.has(key)) return
    const answered = this.answeredOwners.get(key)
    if (answered && [...artifactOwners].every((owner) => answered.has(owner))) return
    this.reads.add(key)
    void this.listDelegated(serverId, sessionId).catch(() => null).then((ids) => {
      this.reads.delete(key)
      this.answeredOwners.set(key, new Set([...(answered ?? []), ...artifactOwners]))
      this.delegated.set(key, ids ? new Set(ids) : this.delegated.get(key) ?? new Set())
    })
  }
}

/** The sessions that own an artifact in the reader's works list. */
export function artifactOwners(works: Iterable<WorkMeta>): ReadonlySet<string> {
  const owners = new Set<string>()
  for (const work of works) {
    if (work.type !== 'artifact') continue
    if (work.sessionId) owners.add(work.sessionId)
    for (const id of work.sessionIds ?? []) owners.add(id)
  }
  return owners
}

function keyOf(serverId: string, sessionId: string): string {
  return `${serverId}\u0000${sessionId}`
}

export const delegatedSessions = new DelegatedSessionsStore()
