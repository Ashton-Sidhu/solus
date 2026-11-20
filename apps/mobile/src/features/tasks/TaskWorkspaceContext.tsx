import { Linking } from 'react-native'
import type { TaskDetails, TaskSessionLink } from '@solus/contracts/task-types'
import { AppText as Text } from '../../components/AppText'
import { TaskAction, taskFailure } from './task-controls'

export function TaskWorkspaceContext({
  details,
  sessions,
  hostId,
  onOpenSession,
  onError
}: {
  details: TaskDetails
  sessions: TaskSessionLink[]
  hostId: string
  onOpenSession: (hostId: string, sessionId: string) => void
  onError: (message: string) => void
}) {
  return (
    <>
      {' '}
      <Text className="text-base font-t3-medium text-foreground">Solus sessions</Text>
      {sessions.map((session) => (
        <TaskAction
          key={`${session.executionServerId ?? hostId}:${session.sessionId}`}
          onPress={() => onOpenSession(session.executionServerId ?? hostId, session.sessionId)}
        >
          {session.sessionTitle ?? 'Session'}
          {session.branch ? ` · ${session.branch}` : ''}
        </TaskAction>
      ))}
      <Text className="text-base font-t3-medium text-foreground">Solus attachments</Text>
      {details.links.map((link) =>
        link.url ? (
          <TaskAction
            key={`${link.kind}:${link.targetScope}:${link.targetKey}`}
            onPress={() =>
              void Linking.openURL(link.url!).catch((failure) => onError(taskFailure(failure)))
            }
          >
            {link.liveTitle ?? link.title} · {link.kind}
          </TaskAction>
        ) : (
          <Text
            key={`${link.kind}:${link.targetScope}:${link.targetKey}`}
            className="text-sm text-foreground-muted"
          >
            {link.liveTitle ?? link.title} · {link.kind}
          </Text>
        )
      )}
      <Text className="text-base font-t3-medium text-foreground">Solus activity</Text>
      {details.activity
        .filter((event) => event.kind === 'task_changed')
        .map((event) => (
          <Text key={event.id} className="text-sm text-foreground-muted">
            {event.kind === 'task_changed' ? event.change.replaceAll('_', ' ') : ''} ·{' '}
            {new Date(event.at).toLocaleString()}
          </Text>
        ))}
    </>
  )
}
