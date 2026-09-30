/**
 * Which host "Just chat" opens Scratchpad on (decision S6, docs/projects.md):
 *
 * 1. The host last used for a Scratchpad chat, while it is up.
 * 2. At a Solus Cloud origin: the organization's managed host — up first,
 *    else the one that is stopped, which the run picker then starts.
 * 3. On desktop: this computer's own host.
 * 4. Else the new-work default host, when it can run sessions.
 *
 * Null when none applies. The chat folder itself comes from the host chosen.
 */

export interface ChatHost {
  serverId: string
  online: boolean
  /** A host Solus cloud runs for the organization. */
  managed: boolean
  /** The desktop's own host. */
  local: boolean
}

export interface ChatHostPreferences {
  /** The web client at a signed-in Solus Cloud origin. */
  atCloudOrigin: boolean
  /** The host of the last Scratchpad chat on this device. */
  lastChatServerId: string | null
  /** The host new work lands on when nothing else names one. */
  defaultServerId: string | null
}

export function chooseChatHost(hosts: readonly ChatHost[], preferences: ChatHostPreferences): string | null {
  const last = hosts.find((host) => host.serverId === preferences.lastChatServerId && host.online)
  if (last) return last.serverId
  if (preferences.atCloudOrigin) {
    const managed = hosts.find((host) => host.managed && host.online) ?? hosts.find((host) => host.managed)
    if (managed) return managed.serverId
  }
  const local = hosts.find((host) => host.local)
  if (local) return local.serverId
  return hosts.find((host) => host.serverId === preferences.defaultServerId)?.serverId ?? null
}
