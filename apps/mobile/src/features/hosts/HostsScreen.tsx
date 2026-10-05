import { useEffect, useLayoutEffect } from 'react'
import { Alert, ScrollView, Text, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space, type } from '../../theme/tokens'
import { Button, EmptyState, Row, StatusDot } from '../../ui/primitives'
import { SymbolButton } from '../../ui/app-symbol'
import { unreadCountLabel } from '@solus/client-core/notifications/presentation'
import type { HostConnectionState } from './host-connections'
import type { NativeHost } from './host-registry'

interface HostStatusText {
  text: string
  tone: 'ok' | 'pending' | 'error' | 'idle'
}

function describe(host: NativeHost, state: HostConnectionState | null): HostStatusText {
  if (!state) return { text: 'Not connected', tone: 'idle' }
  switch (state.phase) {
    case 'connected': return { text: 'Connected', tone: 'ok' }
    case 'connecting': return { text: 'Connecting…', tone: 'pending' }
    case 'reconnecting': return { text: 'Reconnecting…', tone: 'pending' }
    case 'offline': return { text: 'Offline — retrying', tone: 'error' }
    case 'waiting-for-compute': return { text: 'Host is not running', tone: 'idle' }
    case 'no-route': return { text: 'No address yet', tone: 'idle' }
    case 'blocked':
      return state.blockedReason === 'identity-mismatch'
        ? { text: 'A different machine answered at this address', tone: 'error' }
        : { text: host.paired ? 'Access ended — pair again' : 'Access refused', tone: 'error' }
  }
}

/** Every host this device knows, its live state, and the way out of each. */
export function HostsScreen({ navigation }: ScreenProps<'Hosts'>) {
  const app = useApp()
  const palette = usePalette()
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const account = useListened(app.account.changes, () => app.account.view)
  const notifications = useListened(app.notifications.changes, app.notifications.snapshot)
  const unreadLabel = unreadCountLabel(notifications.unread)

  // T3 Code's home keeps Settings one tap away in the header.
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: () => <SymbolButton name="settings" label="Settings" onPress={() => navigation.navigate('Settings')} /> })
  }, [navigation])

  useEffect(() => {
    // Saved hosts are eagerly connected, as on desktop and web.
    for (const host of hosts) app.connections.connection(host.id)
  }, [app, hosts])

  const hostActions = (host: NativeHost) => {
    Alert.alert(host.label, undefined, [
      { text: 'Retry now', onPress: () => app.connections.retry(host.id) },
      ...(host.paired ? [{ text: 'Pair again', onPress: () => navigation.navigate('PairHost') }] : []),
      {
        text: 'Forget this host',
        style: 'destructive' as const,
        onPress: () => Alert.alert('Forget this host?', 'This device removes its access, unsent prompts, and drafts for this host. The host keeps its sessions.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Forget', style: 'destructive', onPress: () => void app.registry.forget(host.id) },
        ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.canvas }}>
      {hosts.length === 0 ? (
        <EmptyState title="No hosts yet" message="Pair a host on your network, or sign in to use your account's hosts." />
      ) : (
        hosts.map((host) => (
          <HostRow key={host.id} host={host} onOpen={() => navigation.navigate('Projects', { hostId: host.id })} onActions={() => hostActions(host)} />
        ))
      )}
      <View style={{ padding: space.lg, gap: space.md }}>
        <Button
          label={unreadLabel ? `Notifications · ${unreadLabel} unread` : 'Notifications'}
          accessibilityHint="Review requests, assignments, and finished runs addressed to you"
          onPress={() => navigation.navigate('Notifications')}
        />
        <Button tone="primary" label="Add a host" onPress={() => navigation.navigate('PairHost')} />
        {account.kind === 'signed-in' ? (
          <>
            <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>Signed in as {account.profile.email}</Text>
            <Button label="Account hosts and organization" onPress={() => navigation.navigate('CloudHosts')} />
            <Button
              tone="danger"
              label="Sign out of Solus Cloud"
              onPress={() => Alert.alert('Sign out?', signOutMessage(app.personalSync.current().pendingKeys.length), [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: () => void app.account.signOut() },
              ])}
            />
          </>
        ) : (
          <Button label="Sign in to Solus Cloud" onPress={() => navigation.navigate('CloudSignIn')} />
        )}
      </View>
    </ScrollView>
  )
}

/** One host's row; it alone re-renders when its connection changes. */
function HostRow({ host, onOpen, onActions }: { host: NativeHost; onOpen: () => void; onActions: () => void }) {
  const app = useApp()
  const state = useListened(app.connections.changes, () => app.connections.state(host.id))
  const status = describe(host, state)
  return (
    <Row
      title={host.label}
      subtitle={status.text}
      accessibilityHint="Opens this host's projects"
      onPress={onOpen}
      trailing={<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <StatusDot tone={status.tone} />
        <Button tone="plain" label="More" accessibilityHint={`Actions for ${host.label}`} onPress={onActions} />
      </View>}
    />
  )
}

/** Sign-out also ends settings sync here; unsent changes are named before they go (plans/018 §5). */
function signOutMessage(unsentSettings: number): string {
  const hosts = 'Hosts from your account leave this device. Hosts you paired directly stay.'
  if (unsentSettings === 0) return hosts
  return `${hosts} ${unsentSettings === 1 ? '1 settings change has' : `${unsentSettings} settings changes have`} not synced and will not reach your account.`
}
