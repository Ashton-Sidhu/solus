import { Linking } from 'react-native'
import type { Task } from '@solus/contracts/task-types'
import { AppText as Text } from '../../components/AppText'
import { PullRequestMarkdown } from '../prs/detail/PullRequestMarkdown'
import { TaskAction, taskFailure } from './task-controls'

export function TaskPageHeader({
  task,
  fromCache,
  readOnly,
  onError
}: {
  task: Task
  fromCache?: boolean
  readOnly: boolean
  onError: (message: string) => void
}) {
  return (
    <>
      <Text className="text-xl font-t3-medium text-foreground">{task.title}</Text>
      <Text className="text-sm text-foreground-muted">
        {task.reference ?? 'Draft'} · {task.state.name}
        {readOnly ? ' · Read-only inspection' : ''}
        {fromCache ? ' · Saved copy' : ''}
      </Text>
      <PullRequestMarkdown markdown={task.body || '_No description._'} />
      {task.url ? (
        <TaskAction
          onPress={() =>
            void Linking.openURL(task.url!).catch((failure) => onError(taskFailure(failure)))
          }
        >
          Open on provider
        </TaskAction>
      ) : null}
    </>
  )
}
