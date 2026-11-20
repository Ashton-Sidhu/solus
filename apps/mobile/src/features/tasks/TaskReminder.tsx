import { useState } from 'react'
import { View } from 'react-native'
import type { TasksStore } from '@solus/client-core/tasks-store'
import { AppText as Text } from '../../components/AppText'
import { TaskAction, TaskField, type TaskCommand } from './task-controls'

export function TaskReminder({
  taskId,
  store,
  until,
  busy,
  act
}: {
  taskId: string
  store: TasksStore
  until?: number
  busy: boolean
  act: TaskCommand
}) {
  const [note, setNote] = useState('')
  const snoozed = until !== undefined && until > Date.now()
  return (
    <View className="gap-2">
      <Text className="text-base font-t3-medium text-foreground">Reminder</Text>
      {snoozed ? (
        <>
          <Text className="text-sm text-foreground-muted">
            Snoozed until {new Date(until).toLocaleString()}
          </Text>
          <TaskAction disabled={busy} onPress={() => void act(() => store.snooze(taskId, null))}>
            Wake task
          </TaskAction>
        </>
      ) : (
        <>
          <TaskField
            label="Reminder note"
            value={note}
            onChangeText={setNote}
            maxLength={1000}
            editable={!busy}
          />
          <View className="flex-row gap-2">
            <TaskAction
              disabled={busy}
              onPress={() => void act(() => store.snooze(taskId, Date.now() + 60 * 60_000, note))}
            >
              Snooze 1 hour
            </TaskAction>
            <TaskAction
              disabled={busy}
              onPress={() =>
                void act(() => store.snooze(taskId, Date.now() + 24 * 60 * 60_000, note))
              }
            >
              Snooze 1 day
            </TaskAction>
          </View>
        </>
      )}
    </View>
  )
}
