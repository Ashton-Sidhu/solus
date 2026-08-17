import type { SessionMeta } from '../shared/types'
import type { HostApi } from './host-api'
import { serverConnections } from './server-connections'

interface SessionMetaHosts {
  resolveId(serverId: string): string
  apiFor(serverId: string): Pick<HostApi, 'getSessionInfo'>
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

