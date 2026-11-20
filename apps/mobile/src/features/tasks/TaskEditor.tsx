import { useState } from 'react'
import { View } from 'react-native'
import type { TasksStore } from '@solus/client-core/tasks-store'
import type {
  Task,
  TaskPriority,
  TaskSourceState,
  TaskUpdatePatch
} from '@solus/contracts/task-types'
import { AppText as Text } from '../../components/AppText'
import { TaskAction, TaskField, type TaskCommand } from './task-controls'

type EditorProps = { task: Task; store: TasksStore; busy: boolean; act: TaskCommand }
export function TaskEditor(
  props: EditorProps & { sources: TaskSourceState[]; onStartSession: () => void }
) {
  return (
    <>
      <TaskFields {...props} />
      <TaskAction disabled={props.busy} onPress={props.onStartSession}>
        Start a session
      </TaskAction>
      <TaskAssignees {...props} />
      <TaskContentEditor {...props} />
      <TaskMoves {...props} />
    </>
  )
}

function TaskFields({ task, store, busy, act }: EditorProps) {
  const taskId = task.id
  const [labelsDraft, setLabelsDraft] = useState<string | null>(null),
    [dueDraft, setDueDraft] = useState<string | null>(null)
  const [priorityDraft, setPriorityDraft] = useState<TaskPriority | null | undefined>()
  return (
    <>
      {' '}
      {task.writableFields.includes('labels') ? (
        <TaskField
          label="Labels, separated by commas"
          value={labelsDraft ?? task.labels.join(', ')}
          onChangeText={setLabelsDraft}
          editable={!busy}
        />
      ) : null}
      {task.writableFields.includes('dueDate') ? (
        <TaskField
          label="Due date (YYYY-MM-DD)"
          value={dueDraft ?? task.dueDate ?? ''}
          onChangeText={setDueDraft}
          editable={!busy}
        />
      ) : null}
      {task.writableFields.includes('priority') ? (
        <View className="flex-row flex-wrap gap-2">
          {(['urgent', 'high', 'medium', 'low', null] as const).map((priority) => (
            <TaskAction
              key={priority ?? 'none'}
              disabled={busy}
              selected={
                (priorityDraft === undefined ? (task.priority ?? null) : priorityDraft) === priority
              }
              onPress={() => setPriorityDraft(priority)}
            >
              {priority ?? 'No priority'}
            </TaskAction>
          ))}
        </View>
      ) : null}
      <TaskAction
        disabled={
          busy || (labelsDraft === null && dueDraft === null && priorityDraft === undefined)
        }
        onPress={() =>
          void act(async () => {
            const patch: TaskUpdatePatch = {}
            if (labelsDraft !== null)
              patch.labels = labelsDraft
                .split(',')
                .map((label) => label.trim())
                .filter(Boolean)
            if (dueDraft !== null) patch.dueDate = dueDraft || null
            if (priorityDraft !== undefined) patch.priority = priorityDraft
            await store.update(taskId, patch)
            setLabelsDraft(null)
            setDueDraft(null)
            setPriorityDraft(undefined)
          })
        }
      >
        Save fields
      </TaskAction>
    </>
  )
}

function TaskAssignees({ task, store, busy, act }: EditorProps) {
  const taskId = task.id
  const [assignees, setAssignees] = useState<string | null>(null)
  return (
    <>
      {' '}
      <Text className="text-sm text-foreground-muted">
        Assignees:{' '}
        {(
          task.assignees?.map((person) => person.login) ?? (task.assignee ? [task.assignee] : [])
        ).join(', ') || 'None'}
      </Text>
      {task.writableFields.includes('assignee') ? (
        <>
          <TaskField
            editable={!busy}
            label={task.providerId === 'github' ? 'Assignees, separated by commas' : 'Assignee'}
            value={
              assignees ??
              task.assignees?.map((person) => person.login).join(', ') ??
              task.assignee ??
              ''
            }
            onChangeText={setAssignees}
            autoCapitalize="none"
          />
          <TaskAction
            disabled={busy || assignees === null}
            onPress={() =>
              void act(async () => {
                await store.update(
                  taskId,
                  task.providerId === 'github'
                    ? {
                        assignees: (assignees ?? '')
                          .split(',')
                          .map((login) => login.trim())
                          .filter(Boolean)
                      }
                    : { assignee: assignees?.trim() || null }
                )
                setAssignees(null)
              })
            }
          >
            Save assignees
          </TaskAction>
        </>
      ) : null}
    </>
  )
}

function TaskContentEditor({ task, store, busy, act }: EditorProps) {
  const taskId = task.id
  const [title, setTitle] = useState<string | null>(null),
    [body, setBody] = useState<string | null>(null)
  return (
    <>
      {' '}
      {task.writableFields.includes('title') ? (
        <>
          <TaskField
            editable={!busy}
            label="Title"
            value={title ?? task.title}
            onChangeText={setTitle}
          />
          <TaskField
            editable={!busy}
            label="Description"
            value={body ?? task.body}
            onChangeText={setBody}
            multiline
          />
          <TaskAction
            disabled={busy || (title === null && body === null)}
            onPress={() =>
              void act(async () => {
                await store.update(taskId, { title: title ?? task.title, body: body ?? task.body })
                setTitle(null)
                setBody(null)
              })
            }
          >
            Save changes
          </TaskAction>
        </>
      ) : null}
    </>
  )
}

function TaskMoves({
  task,
  store,
  busy,
  act,
  sources
}: EditorProps & { sources: TaskSourceState[] }) {
  const taskId = task.id
  return (
    <>
      {' '}
      <Text className="text-base font-t3-medium text-foreground">Move task</Text>
      <View className="flex-row flex-wrap gap-2">
        {(['open', 'active', 'done'] as const).map((category) => (
          <TaskAction
            key={category}
            disabled={busy}
            selected={task.category === category}
            onPress={() => void act(() => store.move(taskId, { category }))}
          >
            {category}
          </TaskAction>
        ))}
      </View>
      {sources
        .filter((source) => task.placements.some((place) => place.sourceKey === source.sourceKey))
        .map((source) => (
          <View key={source.sourceKey} className="gap-2">
            <Text className="text-sm text-foreground-muted">{source.label}</Text>
            <View className="flex-row flex-wrap gap-2">
              {source.columns.map((column) => (
                <TaskAction
                  key={column.id}
                  disabled={busy}
                  selected={task.placements.some(
                    (place) => place.sourceKey === source.sourceKey && place.columnId === column.id
                  )}
                  onPress={() =>
                    void act(() =>
                      store.move(taskId, { sourceKey: source.sourceKey, columnId: column.id })
                    )
                  }
                >
                  {column.name}
                </TaskAction>
              ))}
            </View>
          </View>
        ))}
    </>
  )
}
