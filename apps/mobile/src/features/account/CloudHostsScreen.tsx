import { useEffect, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { radius, space, type } from '../../theme/tokens'
import { Banner, Button, EmptyState, Row } from '../../ui/primitives'
import { cloudHostsFor, cloudHostState, type CloudHostState } from './lib/host-scope'

const STATE_TEXT = {
  ready: 'Ready',
  stopped: 'Stopped',
  starting: 'Starting…',
  unavailable: 'Unavailable',
  'no-route': 'Not reachable yet',
} satisfies Record<CloudHostState, string>

/**
 * The account's organizations and hosts. A first-time account with no host is
 * told what is missing and sent to the Solus setup page; this milestone does
 * not provision hosts in the app (plan 017 §1). Pull to refresh adapted from
 * T3 Code `ConnectOnboardingRouteScreen` (MIT, see UPSTREAM.md).
 */
export function CloudHostsScreen({ navigation }: ScreenProps<'CloudHosts'>) {
  const app = useApp()
  const palette = usePalette()
  const view = useListened(app.account.changes, () => app.account.view)
  const directory = useListened(app.account.changes, () => app.account.directory)
  const organizationId = useListened(app.account.changes, () => app.account.organizationId)
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const [starting, setStarting] = useState<string | null>(null)

  useEffect(() => {
    if (view.kind === 'signed-out') navigation.replace('CloudSignIn')
  }, [navigation, view.kind])

  useEffect(() => {
    if (app.account.directory.kind === 'idle') void app.account.refreshDirectory()
  }, [app])

  const visible = cloudHostsFor(hosts, organizationId)
  const workspaces = directory.kind === 'loaded' ? directory.workspaces : []
  const origin = view.kind === 'signed-in' ? view.origin : ''

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      refreshControl={<RefreshControl refreshing={directory.kind === 'loading'} onRefresh={() => void app.account.refreshDirectory()} />}
    >
      {workspaces.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: space.lg, gap: space.sm }}>
          {workspaces.map((workspace) => {
            const selected = workspace.organizationId === organizationId
            return (
              <Pressable
                key={workspace.organizationId}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Organization ${workspace.label}`}
                onPress={() => app.account.selectOrganization(workspace.organizationId)}
                style={{ paddingHorizontal: space.md, minHeight: 36, justifyContent: 'center', borderRadius: radius.lg, backgroundColor: selected ? palette.accent : palette.card, borderWidth: 1, borderColor: palette.border }}
              >
                <Text style={{ color: selected ? palette.onAccent : palette.text, fontSize: type.chrome, fontWeight: '500' }}>{workspace.label}</Text>
              </Pressable>
            )
          })}
        </ScrollView>
      ) : null}
      {directory.kind === 'error' ? <View style={{ padding: space.lg }}><Banner message={`Hosts could not be read: ${directory.message}`} action={<Button label="Try again" onPress={() => void app.account.refreshDirectory()} />} /></View> : null}
      {directory.kind === 'loaded' && visible.length === 0 ? (
        <EmptyState
          title="No host is set up yet"
          message="A conversation needs a host to run its agent. Set one up in Solus, then pull to refresh. You can also pair a host on your network directly."
          action={<View style={{ gap: space.sm, alignSelf: 'stretch' }}>
            <Button tone="primary" label="Open Solus setup" onPress={() => void app.platform.openBrowser(origin)} />
            <Button label="Pair a host directly" onPress={() => navigation.navigate('PairHost')} />
          </View>}
        />
      ) : null}
      {visible.map((host) => {
        const state = cloudHostState(host)
        return (
          <Row
            key={host.id}
            title={host.label}
            subtitle={[STATE_TEXT[state], host.uplink?.ownerName].filter(Boolean).join(' · ')}
            onPress={state === 'ready' ? () => navigation.navigate('Projects', { hostId: host.id }) : undefined}
            trailing={state === 'stopped' ? (
              <Button
                label="Start"
                busy={starting === host.id}
                onPress={() => {
                  setStarting(host.id)
                  void app.account.startManagedHost(host).finally(() => setStarting(null))
                }}
              />
            ) : null}
          />
        )
      })}
      <View style={{ padding: space.lg }}>
        <Button tone="plain" label="All hosts on this device" onPress={() => navigation.navigate('Hosts')} />
      </View>
    </ScrollView>
  )
}
