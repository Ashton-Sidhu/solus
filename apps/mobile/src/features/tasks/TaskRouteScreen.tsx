import { TaskPageHeader } from './TaskPageHeader'
import { TaskReminder } from './TaskReminder'
import { TaskEditor } from './TaskEditor'
import { TaskComments } from './TaskComments'
import { TaskWorkspaceContext } from './TaskWorkspaceContext'
import { TaskProviderContext } from './TaskProviderContext'
import { TaskReactions } from './TaskReactions'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { ScrollView } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { parseTaskKey } from '@solus/contracts/task-sources'
import { useApp } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import type { ScreenProps } from '../../navigation/routes'
import { SettingsScreen } from '../settings/components/SettingsScreen'
import { TaskAction, taskFailure } from './task-controls'
import { useTasks } from './use-tasks'

export function TaskRouteScreen({ route, navigation }: ScreenProps<'Task'>) {
  const { hostId, taskId, readOnly } = route.params
  const app = useApp(),
    { store, state } = useTasks(hostId)
  const details = state.details.get(taskId),
    task = details?.task
  const inspectionStore = store.inspection(taskId)
  const inspection = useSyncExternalStore(
    inspectionStore.subscribe,
    () => inspectionStore.current,
    () => inspectionStore.current
  )
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false)
  const issueId = parseTaskKey(taskId)?.id ?? ''
  useFocusEffect(
    useCallback(() => {
      let active = true
      void store.detail(taskId).catch((failure) => {
        if (active) setError(taskFailure(failure))
      })
      void inspectionStore.refresh()
      const connection = app.connections.connection(hostId)
      const off = connection?.events.subscribe('tasks.invalidated', (event) => {
        if (!event.taskId || event.taskId === taskId)
          void store.detail(taskId).catch((failure) => {
            if (active) setError(taskFailure(failure))
          })
      })
      return () => {
        active = false
        off?.()
      }
    }, [app, store, taskId, hostId, inspectionStore])
  )
  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(taskFailure(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsScreen title={task?.reference ?? 'Task'}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
        {!task ? (
          <TaskAction
            onPress={() =>
              void act(async () => {
                await store.detail(taskId)
              })
            }
          >
            Load task
          </TaskAction>
        ) : (
          <>
            <TaskPageHeader
              task={task}
              fromCache={details?.fromCache}
              readOnly={!!readOnly}
              onError={setError}
            />
            {!readOnly ? (
              <TaskEditor
                task={task}
                store={store}
                sources={state.sources}
                busy={busy}
                act={act}
                onStartSession={() =>
                  navigation.navigate('NewTask', { hostId, taskId, taskHostId: hostId })
                }
              />
            ) : null}
            {!readOnly ? (
              <TaskReminder
                taskId={taskId}
                store={store}
                until={state.tasks.find((item) => item.id === taskId)?.snoozedUntil}
                busy={busy}
                act={act}
              />
            ) : null}
            <Text className="text-base font-t3-medium text-foreground">Issue reactions</Text>
            <TaskReactions
              targetId={issueId}
              inspection={inspection}
              store={inspectionStore}
              busy={busy || !!readOnly}
              act={act}
            />
            {details ? (
              <TaskComments
                details={details}
                store={store}
                inspection={inspection}
                busy={busy}
                readOnly={!!readOnly}
                act={act}
              />
            ) : null}
            {!readOnly && details ? (
              <TaskWorkspaceContext
                details={details}
                sessions={state.sessionsByTask.get(taskId) ?? []}
                hostId={hostId}
                onOpenSession={(hostId, sessionId) =>
                  navigation.navigate('Thread', { hostId, sessionId })
                }
                onError={setError}
              />
            ) : null}
            <TaskProviderContext
              inspection={inspection}
              inspectionStore={inspectionStore}
              onError={setError}
            />
            <TaskAction
              disabled={busy}
              onPress={() =>
                void act(async () => {
                  await store.detail(taskId)
                  await inspectionStore.refresh()
                })
              }
            >
              Refresh task
            </TaskAction>
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  )
}
