// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx (PullRequestFilesRouteScreen) (MIT, see UPSTREAM.md).
import { useMemo, useState } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText as Text } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import { NativeStackScreenOptions } from '../../native/StackHeader'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { PullRequestFiles, type FilesJump } from './detail/PullRequestFiles'
import { usePullRequestView } from './detail/use-pull-request-view'
import { PullRequestMediaContext } from './detail/use-pull-request-media-url'

/**
 * The changed files of a pull request, or of one of its commits, on the
 * native diff surface. It opens from the toolbar, a file of the overview, a
 * commit of the activity, or a guide stop; a file or stop opens at its lines.
 */
export function PullRequestFilesScreen({ navigation, route }: ScreenProps<'PullRequestFiles'>) {
  const { hostId, projectPath, number, commitSha, path, focus } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const insets = useSafeAreaInsets()
  const { state, view, connected, reload } = usePullRequestView(ref)
  // A jump is made once, when the screen opens at a file.
  const [jump] = useState<FilesJump | null>(() => (path ? { path, focus: focus ?? null, id: Date.now() } : null))
  const title = commitSha ? commitSha.slice(0, 7) : 'Changed files'

  return (
    <PullRequestMediaContext.Provider value={ref}>
      <View className="flex-1 bg-screen" style={{ paddingTop: Platform.OS === 'ios' ? insets.top : 0 }}>
        <NativeStackScreenOptions options={{ title, headerTitle: title, unstable_headerSubtitle: `#${number}${connected ? '' : ' · Offline'}` }} />
        <HostStatusBanner hostId={hostId} />
        {view ? (
          <PullRequestFiles
            view={view}
            active
            commitSha={commitSha ?? null}
            onShowAllChanges={() => navigation.setParams({ commitSha: undefined })}
            jump={jump}
          />
        ) : state.kind === 'error' ? (
          <View className="px-5 pt-4">
            <EmptyState title="Pull request unavailable" detail={state.message} actionLabel="Try again" onAction={reload} />
          </View>
        ) : (
          <View className="items-center py-16">
            <ActivityIndicator colorClassName="accent-icon" />
            <Text className="mt-3 text-sm text-foreground-muted">Loading pull request…</Text>
          </View>
        )}
      </View>
    </PullRequestMediaContext.Provider>
  )
}
