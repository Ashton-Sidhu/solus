import { notificationSessionRoute } from '@shared/notification-types'
import type { SavedServer } from '@client-core/server-registry'

export interface PushClickPayload {
  route?: string | null
  sessionId?: string | null
  installationId?: string | null
  entryKey?: string | null
}

export function serverIdForInstallation(
  installationId: string | null | undefined,
  servers: SavedServer[],
): string | null {
  if (!installationId) return null
  return servers.find((server) => server.installationId === installationId)?.id ?? null
}

export function routeForPushClick(payload: PushClickPayload, servers: SavedServer[]): string | null {
  if (payload.route) return payload.route
  if (!payload.sessionId) return null
  const serverId = serverIdForInstallation(payload.installationId, servers)
  return notificationSessionRoute(payload.sessionId, serverId ?? undefined)
}
