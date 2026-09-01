import type { SessionMeta } from '../shared/types'
import type { HostApi } from './host-api'
import { serverConnections } from './server-connections'

interface SessionMetaHosts {
  connectedServerIds(): string[]
  resolveId(serverId: string): string
  apiFor(serverId: string): Pick<HostApi, 'getSessionInfo'>
}

export interface SessionRef {
  sessionId: string
  serverId?: string | null
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
  const resolvedServerId = hosts.resolveId(serverId)
  try {
    const meta = await hosts.apiFor(resolvedServerId).getSessionInfo(sessionId)
    return stampSessionMeta(meta, resolvedServerId)
  } catch {
    return null
  }
}

/** Resolve a scoped ref directly. Resolve a legacy bare id by probing primary
 * first, then the other hosts to which this client already has a connection. */
export async function resolveSessionMetaRef(
  ref: SessionRef,
  hosts: SessionMetaHosts = serverConnections,
): Promise<SessionMeta | null> {
  const serverIds = ref.serverId
    ? [hosts.resolveId(ref.serverId)]
    : hosts.connectedServerIds()

  for (const serverId of new Set(serverIds)) {
    const meta = await readSessionMeta(serverId, ref.sessionId, hosts)
    if (meta) return meta
  }
  return null
}
