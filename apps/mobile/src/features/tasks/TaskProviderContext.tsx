import { Linking } from 'react-native'
import type { TaskDataStore, TaskProviderState } from '@solus/client-core/task-data'
import { AppText as Text } from '../../components/AppText'
import { TaskAction, taskFailure } from './task-controls'

export function TaskProviderContext({
  provider,
  dataStore,
  onError
}: {
  provider: TaskProviderState
  dataStore: TaskDataStore
  onError: (message: string) => void
}) {
  return (
    <>
      {' '}
      <Text className="text-base font-t3-medium text-foreground">Provider pull requests</Text>
      {provider.value?.pullRequests.map((pr) => (
        <TaskAction
          key={pr.url}
          onPress={() =>
            void Linking.openURL(pr.url).catch((failure) => onError(taskFailure(failure)))
          }
        >
          #{pr.number} {pr.title} · {pr.state}
          {pr.closesIssue ? ' · Closes this issue' : ' · References this issue'}
        </TaskAction>
      ))}
      <Text className="text-base font-t3-medium text-foreground">Provider history</Text>
      {provider.value?.unavailableReason ? (
        <Text className="text-sm text-foreground-muted">{provider.value.unavailableReason}</Text>
      ) : null}
      {provider.error ? (
        <Text className="text-sm text-danger-foreground">{provider.error}</Text>
      ) : null}
      {provider.value?.events.map((event) => (
        <Text key={event.id} className="text-sm text-foreground-muted">
          {event.actor ?? 'Provider'} {event.text} · {new Date(event.at).toLocaleString()}
        </Text>
      ))}
      {provider.value?.historyCursor ? (
        <TaskAction
          disabled={provider.loadingMore}
          onPress={() => void dataStore.loadOlderHistory()}
        >
          {provider.loadingMore ? 'Loading…' : 'Load older history'}
        </TaskAction>
      ) : null}
    </>
  )
}
