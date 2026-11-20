import { useEffect, useState } from 'react'
import { Alert, Linking, ScrollView, View } from 'react-native'
import { taskSourceKey } from '@solus/contracts/task-sources'
import type { TaskPriority, TaskCreateInput } from '@solus/contracts/task-types'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import type { ScreenProps } from '../../navigation/routes'
import { SettingsScreen } from '../settings/components/SettingsScreen'
import { TaskAction, TaskField, taskFailure } from './task-controls'
import { useTasks } from './use-tasks'

export function TaskCreateScreen({ route, navigation }: ScreenProps<'TaskCreate'>) {
  const app = useApp(),
    { store, state } = useTasks(route.params.hostId)
  const settings = useListened(app.personal.changes, app.personal.current)
  const [sourceKey, setSourceKey] = useState<string | null>(null)
  const source =
    settings.taskSources.find((source) => taskSourceKey(source) === sourceKey) ??
    settings.taskSources[0]
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [labels, setLabels] = useState(''),
    [dueDate, setDueDate] = useState('')
  const [assignees, setAssignees] = useState<string[]>([])
  const [priority, setPriority] = useState<TaskPriority | null>(null),
    [columnId, setColumnId] = useState<string | undefined>()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (source) void store.loadTemplates(source)
  }, [store, source])
  const planning =
    source?.kind === 'jira-board' ||
    source?.kind === 'jira-project' ||
    source?.kind === 'linear-team'
  const create = async () => {
    if (!source) return
    setBusy(true)
    setError(null)
    try {
      const input: TaskCreateInput = { source, title: title.trim(), body, columnId }
      if (assignees.length) input.assignees = assignees
      if (source.kind !== 'github-project')
        input.labels = labels
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean)
      if (planning) {
        input.priority = priority
        input.dueDate = dueDate || null
      }
      const task = await store.create(input)
      navigation.replace('Task', { hostId: route.params.hostId, taskId: task.id })
    } catch (failure) {
      setError(taskFailure(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsScreen title="New task">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Text className="text-sm text-foreground-muted">Create on</Text>
        <View className="flex-row flex-wrap gap-2">
          {settings.taskSources.map((candidate) => (
            <TaskAction
              disabled={busy}
              key={taskSourceKey(candidate)}
              selected={source && taskSourceKey(source) === taskSourceKey(candidate)}
              onPress={() => {
                setSourceKey(taskSourceKey(candidate))
                setColumnId(undefined)
                setAssignees([])
              }}
            >
              {state.sources.find((held) => held.sourceKey === taskSourceKey(candidate))?.label ??
                taskSourceKey(candidate)}
            </TaskAction>
          ))}
        </View>
        {store.templates.pending ? (
          <Text className="text-sm text-foreground-muted">Loading templates…</Text>
        ) : null}
        {store.templates.error ? (
          <Text className="text-sm text-danger-foreground">{store.templates.error}</Text>
        ) : null}
        {store.templates.templates.map((template) => (
          <TaskAction
            disabled={busy || store.templates.pending}
            key={template.id}
            onPress={() => {
              if (template.url) {
                void Linking.openURL(template.url).catch((failure) =>
                  setError(taskFailure(failure))
                )
                return
              }
              const apply = () => {
                setTitle(template.title)
                setBody(template.body)
                setLabels((template.labels ?? []).join(', '))
                setAssignees(template.assignees ?? [])
              }
              if (title || body)
                Alert.alert(
                  'Replace draft with template?',
                  'Your current title and description will be replaced.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Apply template', onPress: apply }
                  ]
                )
              else apply()
            }}
          >
            {template.name}
            {template.url ? ' · Open provider form' : ''}
          </TaskAction>
        ))}
        <TaskField
          editable={!busy}
          label="Title"
          value={title}
          onChangeText={setTitle}
          maxLength={1024}
        />
        <TaskField
          editable={!busy}
          label="Description"
          value={body}
          onChangeText={setBody}
          multiline
        />
        {source?.kind !== 'github-project' ? (
          <TaskField
            editable={!busy}
            label="Labels, separated by commas"
            value={labels}
            onChangeText={setLabels}
          />
        ) : null}
        {planning ? (
          <>
            <TaskField
              editable={!busy}
              label="Due date (YYYY-MM-DD)"
              value={dueDate}
              onChangeText={setDueDate}
            />
            <View className="flex-row flex-wrap gap-2">
              {(['urgent', 'high', 'medium', 'low'] as const).map((value) => (
                <TaskAction
                  disabled={busy}
                  key={value}
                  selected={priority === value}
                  onPress={() => setPriority(priority === value ? null : value)}
                >
                  {value}
                </TaskAction>
              ))}
            </View>
          </>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          {state.sources
            .find((held) => source && held.sourceKey === taskSourceKey(source))
            ?.columns.map((column) => (
              <TaskAction
                disabled={busy}
                key={column.id}
                selected={columnId === column.id}
                onPress={() => setColumnId(columnId === column.id ? undefined : column.id)}
              >
                {column.name}
              </TaskAction>
            ))}
        </View>
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
        <TaskAction disabled={!source || busy || !title.trim()} onPress={() => void create()}>
          {busy ? 'Creating…' : 'Create task'}
        </TaskAction>
      </ScrollView>
    </SettingsScreen>
  )
}
