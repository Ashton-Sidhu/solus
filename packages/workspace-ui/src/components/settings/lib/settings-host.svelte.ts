/**
 * The host the host-scoped settings tabs show. Held outside the page so
 * another settings surface, such as a host's Connections page, can open a tab
 * on that host. Empty until the user picks one: the page then shows the Run
 * on host.
 */
class SettingsHost {
  serverId = $state('')
}

export const settingsHost = new SettingsHost()
