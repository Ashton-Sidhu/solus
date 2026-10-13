// Adapted from T3 Code apps/mobile/src/features/workspace/AndroidWorkspaceNavigation.android.tsx (MIT, see UPSTREAM.md).
import { Keyboard, Pressable, View } from 'react-native'
import { useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { useAndroidControlSizing } from '../../components/useAndroidControlSizing'
import { cn } from '../../lib/cn'
import { WORKSPACE_TAB_LABELS, type WorkspaceTab } from './workspace-tabs-state'

const TABS = [
  { tab: 'chats', icon: 'text.bubble' },
  { tab: 'pullRequests', icon: 'arrow.triangle.pull' },
] as const

/**
 * The Material 3 navigation bar of the Android workspace. T3 draws it with
 * its own native view (`T3WorkspaceNavigation`); Solus has no such module, so
 * the bar is drawn in React Native with the same anatomy: an 80dp bar, a pill
 * indicator behind the selected icon, and a label under each icon. It hides
 * while the keyboard is open.
 */
export function AndroidWorkspaceNavigation(props: { readonly selectedTab: WorkspaceTab; readonly onSelect: (tab: WorkspaceTab) => void }) {
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardState((state) => state.isVisible)
  const { scale } = useAndroidControlSizing()
  if (keyboardVisible) return null
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-header-border bg-header"
      style={{ height: 80 * Math.max(1, scale) + insets.bottom, paddingBottom: insets.bottom }}
    >
      {TABS.map(({ tab, icon }) => {
        const selected = props.selectedTab === tab
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={WORKSPACE_TAB_LABELS[tab]}
            accessibilityState={{ selected }}
            android_ripple={{ borderless: true, radius: 40 }}
            onPress={() => {
              Keyboard.dismiss()
              if (!selected) props.onSelect(tab)
            }}
            className="flex-1 items-center justify-center gap-1"
          >
            <View className={cn('h-8 w-16 items-center justify-center rounded-full', selected && 'bg-secondary')}>
              <SymbolView name={icon} size={24} tintColorClassName={selected ? 'accent-secondary-foreground' : 'accent-header-foreground'} />
            </View>
            <Text className={cn('text-xs', selected ? 'font-t3-bold text-header-foreground' : 'font-t3-medium text-foreground-muted')} numberOfLines={1}>
              {WORKSPACE_TAB_LABELS[tab]}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
