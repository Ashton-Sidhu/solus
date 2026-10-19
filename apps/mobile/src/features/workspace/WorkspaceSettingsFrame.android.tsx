import { useNavigationState } from '@react-navigation/native'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAdaptiveWorkspaceLayout } from '../layout/AdaptiveWorkspaceLayout'
import { AndroidWorkspaceNavigation } from './AndroidWorkspaceNavigation'
import { settingsOpenedFromHome } from './workspace-destinations'

/**
 * The layout of each settings page. On an Android phone, Settings opened from
 * the navigation bar keeps the bar under its pages, with Settings selected, so
 * a list tab is one tap away. Settings opened over a conversation shows the
 * page alone, and so does a split layout, which has the rail.
 */
export function WorkspaceSettingsFrame(props: { readonly children: ReactNode }) {
  const { layout } = useAdaptiveWorkspaceLayout()
  const insets = useSafeAreaInsets()
  const destination = useNavigationState(settingsOpenedFromHome)
  const showsBar = destination && !layout.usesSplitView
  // One tree whether or not the bar shows, so a page keeps its state when the bar comes and goes.
  return (
    <View className="flex-1 bg-header">
      <SafeAreaInsetsContext.Provider value={showsBar ? { ...insets, bottom: 0 } : insets}>
        <View className="flex-1">{props.children}</View>
      </SafeAreaInsetsContext.Provider>
      {showsBar ? <AndroidWorkspaceNavigation settingsOpen /> : null}
    </View>
  )
}
