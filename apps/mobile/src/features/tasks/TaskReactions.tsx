import { View } from 'react-native'
import type { TaskInspectionStore, TaskInspectionState } from '@solus/client-core/task-inspection'
import type { TaskReactionContent } from '@solus/contracts/task-inspection'
import { TaskAction, type TaskCommand } from './task-controls'
const REACTIONS: Array<{ content: TaskReactionContent; label: string }> = [
  { content: 'THUMBS_UP', label: '👍' },
  { content: 'THUMBS_DOWN', label: '👎' },
  { content: 'LAUGH', label: '😄' },
  { content: 'HOORAY', label: '🎉' },
  { content: 'CONFUSED', label: '😕' },
  { content: 'HEART', label: '❤️' },
  { content: 'ROCKET', label: '🚀' },
  { content: 'EYES', label: '👀' }
]
export function TaskReactions({
  targetId,
  inspection,
  store,
  busy,
  act
}: {
  targetId: string
  inspection: TaskInspectionState
  store: TaskInspectionStore
  busy: boolean
  act: TaskCommand
}) {
  if (!inspection.value?.capabilities.reactions) return null
  return (
    <View className="flex-row flex-wrap gap-1">
      {REACTIONS.map((reaction) => {
        const held = inspection.value?.reactions.find(
          (item) => item.targetId === targetId && item.content === reaction.content
        )
        return (
          <TaskAction
            key={reaction.content}
            disabled={busy}
            selected={held?.viewerHasReacted}
            onPress={() =>
              void act(() => store.react(targetId, reaction.content, !held?.viewerHasReacted))
            }
          >
            {reaction.label} {held?.count || ''}
          </TaskAction>
        )
      })}
    </View>
  )
}
