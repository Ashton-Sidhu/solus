import { useLayoutEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { Banner, Button } from '../../ui/primitives'
import { NavigationRow, GroupedScroll, GroupedSection, SwitchRow } from '../../ui/grouped-rows'
import { useGithubConnection } from './use-github-connection'
import { useHostSettings } from './use-host-settings'

/**
 * One host's own settings, which every device using the host shares. Your
 * agent defaults and notifications are personal and live under Personal; a
 * host never holds them (plans/018).
 */
export function HostSettingsScreen({ navigation, route }: ScreenProps<'HostSettings'>) {
  const { hostId } = route.params
  const app = useApp()
  const host = useListened(app.registry.changes, () => app.registry.host(hostId))
  const github = useGithubConnection(hostId)
  const { state, reload, update } = useHostSettings(hostId)

  useLayoutEffect(() => {
    navigation.setOptions({ title: host?.label ?? 'Host settings' })
  }, [host?.label, navigation])

  const githubValue = github.view.kind === 'connected'
    ? github.view.login ?? 'Connected'
    : github.view.kind === 'disconnected' ? 'Not connected'
    : github.view.kind === 'error' ? 'Unavailable'
    : github.view.kind === 'connecting' ? 'Connecting…'
    : undefined

  return (
    <GroupedScroll>
      <HostStatusBanner hostId={hostId} />
      {state.kind === 'loaded' ? (
        <GroupedSection title="Sessions" footer="When the host restarts, it resumes the turns that were running. Every device using this host shares this setting.">
          <SwitchRow icon="restart"
            label="Continue sessions after restart"
            value={state.settings.continueSessionsAfterHostRestart}
            onChange={(next) => update({ continueSessionsAfterHostRestart: next })}
          />
        </GroupedSection>
      ) : state.kind === 'error' ? (
        <Banner message={`Settings could not be read: ${state.message}`} action={<Button label="Try again" onPress={reload} />} />
      ) : (
        <View style={{ padding: 24 }}><ActivityIndicator accessibilityLabel="Reading settings" /></View>
      )}
      <GroupedSection title="Source control" footer="Pull requests on this host use its GitHub connection.">
        <NavigationRow icon="sourceControl" label="GitHub" value={githubValue} onPress={() => navigation.navigate('GitHubConnection', { hostId })} />
      </GroupedSection>
    </GroupedScroll>
  )
}
