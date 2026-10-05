import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The host the host-scoped settings tabs show. Held outside the page so
 * another settings surface, such as a host's Connections page, can open a tab
 * on that host.
 */
class SettingsHost {
  serverId = $state(serverConnections.defaultMachineId() ?? '')
}

export const settingsHost = new SettingsHost()
