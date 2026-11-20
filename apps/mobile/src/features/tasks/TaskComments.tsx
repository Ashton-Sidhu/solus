import { useState } from 'react'
import { View } from 'react-native'
import type { TasksStore } from '@solus/client-core/tasks-store'
import type { TaskInspectionState } from '@solus/client-core/task-inspection'
import type { TaskDetails } from '@solus/contracts/task-types'
import { AppText as Text } from '../../components/AppText'
import { PullRequestMarkdown } from '../prs/detail/PullRequestMarkdown'
import { TaskAction, TaskField, type TaskCommand } from './task-controls'
import { TaskReactions } from './TaskReactions'

export function TaskComments({
  details,
  store,
  inspection,
  busy,
  readOnly,
  act
}: {
  details: TaskDetails
  store: TasksStore
  inspection: TaskInspectionState
  busy: boolean
  readOnly: boolean
  act: TaskCommand
}) {
  const taskId = details.task.id
  const [comment, setComment] = useState(''),
    [targetId, setTargetId] = useState<string | null>(null)
  const reactions = (targetId: string) => (
    <TaskReactions
      targetId={targetId}
      inspection={inspection}
      store={store.inspection(taskId)}
      busy={busy || readOnly}
      act={act}
    />
  )
  return (
    <>
      {' '}
      <Text className="text-base font-t3-medium text-foreground">Comments</Text>
      {inspection.value?.author ? (
        <Text className="text-sm text-foreground-muted">Opened by {inspection.value.author}</Text>
      ) : null}
      {inspection.value?.commentsTruncated ? (
        <Text className="text-sm text-foreground-muted">
          The provider returned only part of the comments. Open the provider to read all comments.
        </Text>
      ) : null}
      {details?.comments.map((entry) => (
        <View key={entry.id} className="gap-2 rounded-xl border border-border p-3">
          <Text className="text-sm text-foreground-muted">
            {entry.externalAuthor ?? 'Author'} · {new Date(entry.createdAt).toLocaleString()}
          </Text>
          <PullRequestMarkdown markdown={entry.body} />
          {entry.unsent ? (
            <>
              <Text className="text-sm text-danger-foreground">Not sent: {entry.sendError}</Text>
              <View className="flex-row gap-2">
                <TaskAction
                  disabled={busy || readOnly}
                  onPress={() => void act(() => store.retryComment(taskId, entry.id))}
                >
                  Retry
                </TaskAction>
                <TaskAction
                  disabled={busy || readOnly}
                  onPress={() => void act(() => store.discardComment(taskId, entry.id))}
                >
                  Discard
                </TaskAction>
              </View>
            </>
          ) : (
            <>
              <TaskAction onPress={() => setTargetId(targetId === entry.id ? null : entry.id)}>
                Reactions
              </TaskAction>
              {targetId === entry.id && entry.providerCommentId
                ? reactions(entry.providerCommentId)
                : null}
            </>
          )}
        </View>
      ))}
      {!readOnly ? (
        <>
          <TaskField
            editable={!busy}
            label="Comment"
            value={comment}
            onChangeText={setComment}
            multiline
          />
          <TaskAction
            disabled={busy || !comment.trim()}
            onPress={() =>
              void act(async () => {
                await store.comment(taskId, comment)
                setComment('')
              })
            }
          >
            Post comment
          </TaskAction>
        </>
      ) : null}
    </>
  )
}
