import { useState } from 'react'
import { View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { useLinearConnection } from '../settings/use-linear-connection'
import { TaskAction, TaskField } from './task-controls'

/**
 * Connect Linear on the task sources screen: the teams read again after a
 * saved key, so the person picks one here. A person who may not save a key
 * on this host goes to the Linear screen instead.
 */
export function LinearKeyField({ hostId, problem, onConnected, onOpenSettings }: {
  readonly hostId: string
  /** Why the last read of Linear failed, such as a key Linear refused. */
  readonly problem?: string
  readonly onConnected: () => void
  readonly onOpenSettings: () => void
}) {
  const app = useApp()
  const linear = useLinearConnection(hostId)
  const [key, setKey] = useState('')
  const mayManageHost = useListened(app.connections.changes, () => app.connections.may(hostId, 'host.admin.connections'))
  const canSave = linear.state.location === 'account' || (linear.state.location === 'host' && mayManageHost)
  const connect = async () => {
    const draft = key
    setKey('')
    if (await linear.store.save(draft)) onConnected()
  }
  if (!canSave) return <TaskAction onPress={onOpenSettings}>Connect Linear</TaskAction>
  return (
    <View className="gap-2">
      <TaskField label={problem ?? 'Linear API key'} value={key} onChangeText={setKey} autoCapitalize="none" secureTextEntry />
      <TaskAction disabled={!key.trim() || linear.state.pending} onPress={() => void connect()}>
        {linear.state.pending ? 'Connecting…' : 'Connect Linear'}
      </TaskAction>
      {linear.state.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">{linear.state.error}</Text>
      ) : null}
    </View>
  )
}
