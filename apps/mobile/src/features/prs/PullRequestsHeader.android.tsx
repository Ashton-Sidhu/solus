// Adapted from T3 Code apps/mobile/src/features/pull-requests/MaterialPullRequestToolbar.android.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import { AndroidAnchoredMenu } from '../../components/AndroidAnchoredMenu'
import { useWorkspaceTabs } from '../workspace/WorkspaceTabsContext'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BackHandler,
  Keyboard,
  View,
  type TextInputInstance,
} from 'react-native'
import { AndroidHeaderIconButton } from '../../components/AndroidScreenHeader'
import { CompactBrandTitle } from '../../components/CompactBrandTitle'
import { MaterialSearchField } from '../../components/MaterialSearchField'
import { useMaterialToolbarLayout } from '../../components/useMaterialToolbarLayout'
import { NativeStackScreenOptions } from '../../native/StackHeader'
import { WorkspaceConnectionTitle } from '../home/WorkspaceConnectionTitle'
import type { PullRequestsHeaderProps } from './PullRequestsHeader.types'

/** The Pull Requests tab's Android header: the brand and connection status,
 *  then search and filters, in the Chats tab's places. */
export function PullRequestsHeader(props: PullRequestsHeaderProps) {
  const navigation = useNavigation()
  const { isTabActive } = useWorkspaceTabs()
  const { onSearchQueryChange } = props
  const { height: toolbarHeight, ...headerPadding } = useMaterialToolbarLayout()
  const input = useRef<TextInputInstance>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const searching = searchOpen || props.searchQuery.length > 0
  const openSearch = useCallback(() => {
    setSearchOpen(true)
    input.current?.focus()
  }, [])
  const closeSearch = useCallback(() => {
    onSearchQueryChange('')
    setSearchOpen(false)
    Keyboard.dismiss()
  }, [onSearchQueryChange])
  useEffect(() => {
    if (!searching) return
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        const state = navigation.getState()
        if (
          !state ||
          state.routes[state.index]?.name !== 'Home' ||
          !isTabActive('pullRequests')
        )
          return false
        if (Keyboard.isVisible()) Keyboard.dismiss()
        else closeSearch()
        return true
      },
    )
    return () => subscription.remove()
  }, [closeSearch, searching, navigation, isTabActive])
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <View className="bg-header px-2" style={headerPadding}>
        <View
          className="flex-row items-center gap-1"
          style={{ minHeight: toolbarHeight }}
        >
          {searching ? (
            <>
              <AndroidHeaderIconButton
                accessibilityLabel="Close search"
                icon="arrow.left"
                onPress={closeSearch}
              />
              <MaterialSearchField
                inputRef={input}
                accessibilityLabel="Search pull requests"
                clearAccessibilityLabel="Clear search"
                placeholder="Search pull requests"
                value={props.searchQuery}
                onChangeText={onSearchQueryChange}
              />
            </>
          ) : (
            <>
              {/* Match the visible inset of the trailing 48dp icon button. */}
              <View className="min-w-0 flex-1 pl-4">
                <WorkspaceConnectionTitle
                  grow
                  onPress={props.onOpenEnvironments}
                  brand={<CompactBrandTitle allowFontScaling={false} />}
                />
              </View>
              <AndroidHeaderIconButton
                accessibilityLabel="Search pull requests"
                icon="magnifyingglass"
                onPress={openSearch}
              />
              {props.filterMenu ? (
                <AndroidAnchoredMenu
                  actions={props.filterMenu.actions}
                  onPressAction={({ nativeEvent }) =>
                    props.filterMenu?.onSelect(nativeEvent.event)
                  }
                >
                  {(open) => (
                    <AndroidHeaderIconButton
                      accessibilityLabel="Filter pull requests"
                      icon={
                        props.filterMenu?.customized
                          ? 'line.3.horizontal.decrease.circle.fill'
                          : 'line.3.horizontal.decrease.circle'
                      }
                      onPress={open}
                    />
                  )}
                </AndroidAnchoredMenu>
              ) : null}
            </>
          )}
        </View>
      </View>
    </>
  )
}
