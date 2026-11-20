import { useState } from 'react'
import { Linking } from 'react-native'
import type { TasksStore } from '@solus/client-core/tasks-store'
import type { TaskSourceOptions } from '@solus/contracts/task-types'
import { AppText as Text } from '../../components/AppText'
import { TaskAction, TaskField, taskFailure } from './task-controls'

export function LinearTaskConnection({
  linear,
  store
}: {
  linear: TaskSourceOptions['linear']
  store: TasksStore
}) {
  const [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const connect = async (value: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await store.connectLinear(value)
      setKey('')
    } catch (failure) {
      setError(taskFailure(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Text className="text-base font-t3-medium text-foreground">Linear</Text>
      {linear?.error ? (
        <Text className="text-sm text-danger-foreground">{linear.error}</Text>
      ) : null}
      <Text className="text-sm text-foreground-muted">
        {linear?.connected
          ? `Connected as ${linear.account}`
          : 'Enter a personal API key. It is checked before secure storage.'}
      </Text>
      {linear?.location === 'account' ? (
        <>
          <Text className="text-sm text-foreground-muted">
            Manage Linear in your Solus account.
          </Text>
          {linear.accountConnectionsUrl ? (
            <TaskAction
              onPress={() =>
                void Linking.openURL(linear.accountConnectionsUrl!).catch((failure) =>
                  setError(taskFailure(failure))
                )
              }
            >
              Open account connections
            </TaskAction>
          ) : null}
        </>
      ) : linear?.location === 'host' ? (
        <>
          <TaskField
            editable={!busy}
            maxLength={4096}
            label="Linear API key"
            value={key}
            onChangeText={setKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TaskAction disabled={busy || !key.trim()} onPress={() => void connect(key)}>
            Connect Linear
          </TaskAction>
          {linear?.connected ? (
            <TaskAction disabled={busy} onPress={() => void connect(null)}>
              Disconnect Linear
            </TaskAction>
          ) : null}
        </>
      ) : null}
    </>
  )
}
