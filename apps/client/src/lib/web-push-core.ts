import type { SavedServer } from '@solus/client-core/server-registry'

export interface PushHostRef {
  serverId: string
  installationId?: string
}

export interface PushReconciliation {
  subscribe: PushHostRef[]
  unsubscribe: string[]
}

export function pushHostRefs(
  savedServers: SavedServer[],
  primary?: PushHostRef | null,
): PushHostRef[] {
  const hosts = new Map(savedServers.map((server) => {
    const host: PushHostRef = { serverId: server.id }
    if (server.installationId) host.installationId = server.installationId
    return [server.id, host] as const
  }))
  if (primary) hosts.set(primary.serverId, primary)
  return [...hosts.values()]
}

export function planPushReconciliation(
  hosts: PushHostRef[],
  registeredServerIds: Iterable<string>,
  enabled: boolean,
  removingServerId?: string,
): PushReconciliation {
  const subscribe = enabled
    ? hosts.filter((host) => host.serverId !== removingServerId)
    : []
  const desired = new Set(subscribe.map((host) => host.serverId))
  const known = new Set(registeredServerIds)
  if (removingServerId) known.add(removingServerId)
  return {
    subscribe,
    unsubscribe: [...known].filter((serverId) => !desired.has(serverId)),
  }
}

export async function fanOutPushHosts<T>(
  hosts: PushHostRef[],
  operation: (host: PushHostRef) => Promise<T>,
): Promise<{ fulfilled: Array<{ host: PushHostRef; value: T }>; rejected: PushHostRef[] }> {
  const results = await Promise.allSettled(hosts.map(async (host) => ({ host, value: await operation(host) })))
  const fulfilled: Array<{ host: PushHostRef; value: T }> = []
  const rejected: PushHostRef[] = []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const host = hosts[index]
    if (!host) continue
    if (result?.status === 'fulfilled') fulfilled.push(result.value)
    else rejected.push(host)
  }
  return { fulfilled, rejected }
}
