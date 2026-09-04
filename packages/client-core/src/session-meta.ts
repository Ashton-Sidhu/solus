import type { SessionMeta } from '@solus/contracts/types'
import type { HostApi } from './host-api'
import { serverConnections } from './server-connections'

interface SessionMetaHosts {
  resolveId(serverId: string): string
  apiFor(serverId: string): Pick<HostApi, 'getSessionInfos'>
}

interface PendingSessionMeta {
  resolve(meta: SessionMeta | null): void
}

class SessionMetaReader {
  private readonly pendingByServer = new Map<string, Map<string, PendingSessionMeta[]>>()
  private readonly scheduledServers = new Set<string>()

  constructor(private readonly hosts: SessionMetaHosts) {}

  read(serverId: string, sessionId: string): Promise<SessionMeta | null> {
    const resolvedServerId = this.hosts.resolveId(serverId)
    return new Promise((resolve) => {
      let pending = this.pendingByServer.get(resolvedServerId)
      if (!pending) {
        pending = new Map()
        this.pendingByServer.set(resolvedServerId, pending)
      }
      const listeners = pending.get(sessionId) ?? []
      listeners.push({ resolve })
      pending.set(sessionId, listeners)
      if (this.scheduledServers.has(resolvedServerId)) return
      this.scheduledServers.add(resolvedServerId)
      queueMicrotask(() => void this.flush(resolvedServerId))
    })
  }

  private async flush(serverId: string): Promise<void> {
    this.scheduledServers.delete(serverId)
    const pending = this.pendingByServer.get(serverId)
    if (!pending) return
    this.pendingByServer.delete(serverId)
    const sessionIds = [...pending.keys()]
    let results: Array<SessionMeta | null>
    try {
      results = await this.hosts.apiFor(serverId).getSessionInfos(sessionIds)
    } catch {
      results = sessionIds.map(() => null)
    }
    for (let index = 0; index < sessionIds.length; index++) {
      const sessionId = sessionIds[index]
      const meta = stampSessionMeta(results[index] ?? null, serverId)
      for (const listener of pending.get(sessionId) ?? []) listener.resolve(meta)
    }
  }
}

const readers = new WeakMap<SessionMetaHosts, SessionMetaReader>()

function readerFor(hosts: SessionMetaHosts): SessionMetaReader {
  let reader = readers.get(hosts)
  if (!reader) {
    reader = new SessionMetaReader(hosts)
    readers.set(hosts, reader)
  }
  return reader
}

/** The host is client identity, so stamp it where host data enters the client. */
export function stampSessionMeta(
  meta: SessionMeta | null,
  serverId: string,
): SessionMeta | null {
  if (meta) meta.serverId = serverId
  return meta
}

export function stampSessionMetas(
  sessions: SessionMeta[],
  serverId: string,
): SessionMeta[] {
  for (const meta of sessions) meta.serverId = serverId
  return sessions
}

/** Read one session from one named host. Errors are a normal negative probe. */
export async function readSessionMeta(
  serverId: string,
  sessionId: string,
  hosts: SessionMetaHosts = serverConnections,
): Promise<SessionMeta | null> {
  return readerFor(hosts).read(serverId, sessionId)
}
