import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { APPEARANCE_LABELS, SYNC_STATE_LABELS } from './lib/settings-labels'
import { NavigationRow, GroupedScroll, GroupedSection } from '../../ui/grouped-rows'

/**
 * Settings by owner (plans/018 §7): yours, which follow you to every host and,
 * with sync, every device; this device's own; each organization's settings; and
 * each host's own. Personal settings need no host.
 */
export function SettingsScreen({ navigation }: ScreenProps<'Settings'>) {
  const app = useApp()
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const account = useListened(app.account.changes, () => app.account.view)
  const directory = useListened(app.account.changes, () => app.account.directory)
  const organizationId = useListened(app.account.changes, () => app.account.organizationId)
  const appearance = useListened(app.appearance.changes, app.appearance.current)
  const sync = useListened(app.personalSync.changes, app.personalSync.current)
  const organizationName = directory.kind === 'loaded'
    ? directory.organizations.find((organization) => organization.organizationId === organizationId)?.name
    : undefined

  return (
    <GroupedScroll gap={14}>
      <GroupedSection title="Personal" footer="Yours on every host. With sync on, also on your other devices.">
        <NavigationRow icon="sync" label="Sync" value={SYNC_STATE_LABELS[sync.state]} accessibilityHint="Sync your settings with your account" onPress={() => navigation.navigate('PersonalSettings')} />
        <NavigationRow icon="appearance" label="Appearance" value={APPEARANCE_LABELS[appearance]} onPress={() => navigation.navigate('AppearanceSettings')} />
        <NavigationRow icon="agentDefaults" label="Agent defaults" accessibilityHint="Default agent, model, permissions, and limits" onPress={() => navigation.navigate('AgentDefaults')} />
        <NavigationRow icon="notifications" label="Notifications" accessibilityHint="What you are told about, and how" onPress={() => navigation.navigate('NotificationSettings')} />
      </GroupedSection>

      {account.kind === 'signed-in' ? (
        <GroupedSection title="Organization" footer="Whether your organization syncs all Insights of its work. Owners change it here.">
          <NavigationRow icon="organization" label="Organization settings" value={organizationName} onPress={() => navigation.navigate('OrganizationSettings', organizationId ? { organizationId } : undefined)} />
        </GroupedSection>
      ) : null}

      <GroupedSection title="This device" footer="These stay on this device.">
        <NavigationRow
          icon="account"
          label="Solus Cloud"
          value={account.kind === 'signed-in' ? account.profile.email : 'Sign in'}
          accessibilityHint={account.kind === 'signed-in' ? 'Your account’s hosts and organization' : 'Sign in to use your account’s hosts'}
          onPress={() => navigation.navigate(account.kind === 'signed-in' ? 'CloudHosts' : 'CloudSignIn')}
        />
        <NavigationRow icon="hosts" label="Hosts" value={String(hosts.length)} onPress={() => navigation.navigate('Hosts')} />
        <NavigationRow icon="inbox" label="Inbox" accessibilityHint="Opens your notifications" onPress={() => navigation.navigate('Notifications')} />
      </GroupedSection>

      {hosts.length > 0 ? (
        <GroupedSection title="Host settings" footer="Each host keeps its own machine settings and GitHub connection. Every device that uses the host shares them.">
          {hosts.map((host) => (
            <NavigationRow icon="host" key={host.id} label={host.label} onPress={() => navigation.navigate('HostSettings', { hostId: host.id })} />
          ))}
        </GroupedSection>
      ) : null}

      <GroupedSection title="App">
        <NavigationRow icon="about" label="About Solus" value={app.platform.appVersion} onPress={() => navigation.navigate('About')} />
      </GroupedSection>
    </GroupedScroll>
  )
}
