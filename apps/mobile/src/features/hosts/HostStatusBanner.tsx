import { View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import { space } from '../../theme/tokens'
import { Banner, Button } from '../../ui/primitives'

/** Shown only when the host is not connected: what is wrong and the way out. */
export function HostStatusBanner({ hostId }: { hostId: string }) {
  const app = useApp()
  const state = useListened(app.connections.changes, () => app.connections.state(hostId))
  const host = useListened(app.registry.changes, () => app.registry.host(hostId))
  if (!host) return <View style={{ padding: space.lg }}><Banner message="This host is no longer on this device." /></View>
  if (!state || state.phase === 'connected') return null
  const message = state.phase === 'blocked'
    ? state.blockedReason === 'identity-mismatch'
      ? 'A different machine answered at this host\'s address. Solus did not connect to it.'
      : host.paired ? 'This host no longer accepts this device. Pair it again.' : 'Your account cannot reach this host now.'
    : state.phase === 'offline' ? 'The host is offline. Solus keeps trying.'
    : state.phase === 'waiting-for-compute' ? 'This host is not running.'
    : state.phase === 'no-route' ? 'This host has no address yet.'
    : 'Connecting to the host…'
  const tone = state.phase === 'connecting' || state.phase === 'reconnecting' ? 'info' : 'error'
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
      <Banner tone={tone} message={message} action={state.phase === 'offline' || state.phase === 'blocked' ? <Button label="Retry now" onPress={() => app.connections.retry(hostId)} /> : undefined} />
    </View>
  )
}
