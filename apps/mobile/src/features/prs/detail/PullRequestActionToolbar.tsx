// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestControls.tsx (PullRequestActionToolbar) (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp, useListened } from '../../../app/app-context'
import { ControlPillMenu } from '../../../components/ControlPillMenu'
import { MaterialButton } from '../../../components/MaterialButton'
import { MaterialIconButton } from '../../../components/MaterialIconButton'
import { NativeHeaderToolbar } from '../../../native/StackHeader'
import type { RootStackParamList } from '../../../navigation/routes'
import { useAppearancePreferences } from '../../settings/appearance/AppearancePreferencesProvider'
import { currentReviewComments } from '../lib/pull-request-review-draft'
import { usePullRequestAgent } from './PullRequestAgentActions'
import type { PullRequestView } from './pull-request-view'

/** The height the Android toolbar takes over the list, without the bottom inset. */
export const ANDROID_PULL_REQUEST_TOOLBAR_HEIGHT = 80

/**
 * The bar under a pull request: the agent tasks, the main action, and the
 * changed files. The main action submits the review while draft comments
 * wait, and asks an agent about the pull request otherwise. iOS puts the
 * controls in the native bottom toolbar; Android floats them over the list.
 */
export function PullRequestActionToolbar({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const insets = useSafeAreaInsets()
  const { themeVariables: colors } = useAppearancePreferences()
  const draft = useListened(app.reviewDrafts.changes, () => app.reviewDrafts.draftOf(view.ref))
  const agent = usePullRequestAgent(view)
  const pendingComments = view.permissions.verdicts.length ? currentReviewComments(draft, view.pr.headSha).length : 0
  const pendingReview = pendingComments > 0
  const primaryLabel = pendingReview ? `Submit review · ${pendingComments}` : 'Ask agent'
  const primaryDisabled = !pendingReview && (!agent.available || agent.busy)
  const primaryPress = () => {
    if (pendingReview) navigation.navigate('PullRequestReview', { ...view.ref, mode: 'review' })
    else navigation.navigate('PullRequestAsk', view.ref)
  }
  const tasks = agent.actions.filter((action) => action.task !== 'ask')
  const taskDisabled = (disabled: boolean) => disabled || !agent.available || agent.busy
  const openFiles = () => navigation.navigate('PullRequestFiles', view.ref)

  if (Platform.OS === 'android') {
    return (
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 z-10 items-center px-4 pt-2" style={{ paddingBottom: insets.bottom + 16 }}>
        <View className="flex-row items-center gap-2 rounded-full bg-sheet-solid p-2">
          <ControlPillMenu
            title="AI helpers"
            actions={tasks.map((task) => ({ id: task.task, title: task.title, image: 'sparkles', attributes: { disabled: taskDisabled(task.disabled) } }))}
            onPressAction={({ nativeEvent }) => {
              const task = tasks.find((entry) => entry.task === nativeEvent.event)
              if (task && !taskDisabled(task.disabled)) void agent.start(task.task)
            }}
          >
            <View pointerEvents="none">
              <MaterialIconButton icon="sparkles" accessibilityLabel="Pull request agent actions" disabled={!agent.available || agent.busy} />
            </View>
          </ControlPillMenu>
          <View className="min-w-0 shrink">
            <MaterialButton label={primaryLabel} tone="primary" disabled={primaryDisabled} onPress={primaryPress} />
          </View>
          <MaterialIconButton icon="doc.text" accessibilityLabel="Changed files" onPress={openFiles} />
        </View>
      </View>
    )
  }

  return (
    <NativeHeaderToolbar placement="bottom">
      <NativeHeaderToolbar.Menu icon="sparkles" title="AI helpers" accessibilityLabel="Pull request agent actions" disabled={!agent.available || agent.busy} separateBackground>
        {tasks.map((task) => (
          <NativeHeaderToolbar.MenuAction key={task.task} icon="sparkles" disabled={taskDisabled(task.disabled)} onPress={() => void agent.start(task.task)}>
            <NativeHeaderToolbar.Label>{task.title}</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
        ))}
      </NativeHeaderToolbar.Menu>
      <NativeHeaderToolbar.Spacer flexible />
      <NativeHeaderToolbar.Button
        label={primaryLabel}
        accessibilityLabel={primaryLabel}
        variant="prominent"
        tintColor={colors['--color-prominent-action']}
        disabled={primaryDisabled}
        onPress={primaryPress}
        separateBackground
      />
      <NativeHeaderToolbar.Spacer flexible />
      {/* Tabler file-diff geometry, rasterized at 1x/2x/3x for UIKit template images (T3 Code's asset). */}
      <NativeHeaderToolbar.Button
        icon={{ type: 'image', source: require('../../../../assets/icons/file-diff.png') }}
        accessibilityLabel="Changed files"
        onPress={openFiles}
        separateBackground
      />
    </NativeHeaderToolbar>
  )
}
