// Adapted from T3 Code apps/mobile/src/features/workspace/WorkspaceRootScreen.tsx and WorkspaceRootScreen.android.tsx (MIT, see UPSTREAM.md).
import type { ReactNode } from 'react'
import { Platform, View } from 'react-native'
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAdaptiveWorkspaceLayout } from '../layout/AdaptiveWorkspaceLayout'
import { AndroidWorkspaceNavigation } from './AndroidWorkspaceNavigation'
import { useSidebarWorkspaceTabs } from './use-sidebar-workspace-tabs'
import { WorkspaceSidebarTabs } from './WorkspaceSidebarTabs'

/**
 * The workspace root around the selected tab's screen. On an Android phone
 * the Material navigation bar sits under the screen and takes the bottom
 * inset; a split Android layout has the navigation rail instead
 * (AdaptiveWorkspaceLayout). On iOS the system tab bar is outside the screen
 * (WorkspaceNativeTabs); a wide iPad picks the tab in a segmented control
 * under the navigation bar.
 */
export function WorkspaceTabsFrame(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets()
  const sidebarTabs = useSidebarWorkspaceTabs()
  const { layout } = useAdaptiveWorkspaceLayout()
  if (Platform.OS === 'android' && !layout.usesSplitView) {
    return (
      <View className="flex-1 bg-header">
        <SafeAreaInsetsContext.Provider value={{ ...insets, bottom: 0 }}>
          <View className="flex-1">{props.children}</View>
        </SafeAreaInsetsContext.Provider>
        <AndroidWorkspaceNavigation settingsOpen={false} />
      </View>
    )
  }
  if (Platform.OS === 'android') return <View className="flex-1 bg-header">{props.children}</View>
  if (!sidebarTabs) return <View className="flex-1">{props.children}</View>
  // The picker already clears the navigation bar; the list must not inset it again.
  return (
    <View className="flex-1" style={{ paddingTop: insets.top }}>
      <WorkspaceSidebarTabs />
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>{props.children}</SafeAreaInsetsContext.Provider>
    </View>
  )
}
