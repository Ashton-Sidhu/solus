import { Linking } from 'react-native'
import type { TaskInspectionStore, TaskInspectionState } from '@solus/client-core/task-inspection'
import { AppText as Text } from '../../components/AppText'
import { TaskAction, taskFailure } from './task-controls'

export function TaskProviderContext({
  inspection,
  inspectionStore,
  onError
}: {
  inspection: TaskInspectionState
  inspectionStore: TaskInspectionStore
  onError: (message: string) => void
}) {
  return (
    <>
      {' '}
      <Text className="text-base font-t3-medium text-foreground">Provider pull requests</Text>
      {inspection.value?.pullRequests.map((pr) => (
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
      {inspection.value?.unavailableReason ? (
        <Text className="text-sm text-foreground-muted">{inspection.value.unavailableReason}</Text>
      ) : null}
      {inspection.error ? (
        <Text className="text-sm text-danger-foreground">{inspection.error}</Text>
      ) : null}
      {inspection.value?.events.map((event) => (
        <Text key={event.id} className="text-sm text-foreground-muted">
          {event.actor ?? 'Provider'} {event.text} · {new Date(event.at).toLocaleString()}
        </Text>
      ))}
      {inspection.value?.historyCursor ? (
        <TaskAction
          disabled={inspection.loadingMore}
          onPress={() => void inspectionStore.loadMore()}
        >
          {inspection.loadingMore ? 'Loading…' : 'Load older history'}
        </TaskAction>
      ) : null}
    </>
  )
}
