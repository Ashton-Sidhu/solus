// Adapted from T3 Code apps/mobile/src/features/workspace/AndroidWorkspaceNavigation.android.tsx (MIT, see UPSTREAM.md).
import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import { useKeyboardState } from 'react-native-keyboard-controller'
import Animated, { FadeIn, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { useAndroidControlSizing } from '../../components/useAndroidControlSizing'
import { cn } from '../../lib/cn'
import { WORKSPACE_PANE_TIMING } from '../layout/workspace-pane-animation'
import { useWorkspaceDestinations } from './use-workspace-destinations'
import { WORKSPACE_TAB_LABELS } from './workspace-tabs-state'

const DESTINATIONS = [
  { destination: 'chats', icon: 'text.bubble', label: WORKSPACE_TAB_LABELS.chats },
  { destination: 'pullRequests', icon: 'arrow.triangle.pull', label: WORKSPACE_TAB_LABELS.pullRequests },
  { destination: 'settings', icon: 'gearshape', label: 'Settings' },
] as const

/** The collapsed rail. Material's is 96dp; 72dp leaves the list more room and keeps 48dp targets. */
export const ANDROID_WORKSPACE_RAIL_WIDTH = 72
const EXPANDED_RAIL_WIDTH = 240

/**
 * The Material 3 navigation bar of the Android workspace on a phone: Chats,
 * Pull Requests, and Settings. T3 draws it with its own native view
 * (`T3WorkspaceNavigation`); Solus has no such module, so the bar is drawn in
 * React Native with the same anatomy: an 80dp bar, a pill indicator behind
 * the selected icon, and a label under each icon. It hides while the
 * keyboard is open.
 */
export function AndroidWorkspaceNavigation(props: { readonly settingsOpen: boolean }) {
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardState((state) => state.isVisible)
  const { scale } = useAndroidControlSizing()
  const { selected, choose } = useWorkspaceDestinations(props.settingsOpen)
  if (keyboardVisible) return null
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-header-border bg-header"
      style={{ height: 80 * Math.max(1, scale) + insets.bottom, paddingBottom: insets.bottom }}
    >
      {DESTINATIONS.map(({ destination, icon, label }) => {
        const active = selected === destination
        return (
          <Pressable
            key={destination}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            android_ripple={{ borderless: true, radius: 40 }}
            onPress={() => choose(destination)}
            className="flex-1 items-center justify-center gap-1"
          >
            <View className={cn('h-8 w-16 items-center justify-center rounded-full', active && 'bg-secondary')}>
              <SymbolView name={icon} size={24} tintColorClassName={active ? 'accent-secondary-foreground' : 'accent-header-foreground'} />
            </View>
            <Text className={cn('text-xs', active ? 'font-t3-bold text-header-foreground' : 'font-t3-medium text-foreground-muted')} numberOfLines={1}>
              {label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * The navigation rail of a split Android workspace. It holds the same three
 * destinations as icons, with a menu button and New session at the top. The
 * menu widens it to 240dp over the panes, with labels and a scrim, without
 * reflowing them; Back, the scrim, or a choice closes it. The rail stays drawn
 * while the keyboard is open, as the panes beside it do.
 *
 * It spans the workspace and passes touches through outside its own column,
 * so widening needs no layout change around it. Hidden, it narrows to
 * nothing with the slot the workspace reserves for it.
 */
export function AndroidWorkspaceRail(props: RailProps & { readonly split: boolean }) {
  // A phone has the bar instead (AndroidWorkspaceNavigation).
  return props.split ? <WorkspaceRail {...props} /> : null
}

interface RailProps {
  readonly visible: boolean
  readonly settingsOpen: boolean
  readonly onStartNewTask: () => void
  readonly onSelect: () => void
}

function WorkspaceRail(props: RailProps) {
  const app = useApp()
  const insets = useSafeAreaInsets()
  const hasConnections = useListened(app.registry.changes, () => app.registry.hosts().length > 0)
  const { selected, choose } = useWorkspaceDestinations(props.settingsOpen)
  const [expanded, setExpanded] = useState(false)
  if (expanded && !props.visible) setExpanded(false)
  const target = !props.visible ? 0 : expanded ? EXPANDED_RAIL_WIDTH : ANDROID_WORKSPACE_RAIL_WIDTH
  const width = useSharedValue(target)
  useEffect(() => {
    width.value = withTiming(target, WORKSPACE_PANE_TIMING)
  }, [target, width])
  useEffect(() => {
    if (!expanded) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setExpanded(false)
      return true
    })
    return () => subscription.remove()
  }, [expanded])
  const panelStyle = useAnimatedStyle(() => ({ width: width.value }))
  // Labels appear once there is room and leave before the rail narrows, so they are never clipped.
  const labelEntering = FadeIn.delay(120).duration(120).reduceMotion(ReduceMotion.System)

  return (
    <View
      pointerEvents={props.visible ? 'box-none' : 'none'}
      accessibilityElementsHidden={!props.visible}
      importantForAccessibility={props.visible ? 'auto' : 'no-hide-descendants'}
      style={StyleSheet.absoluteFill}
    >
      {expanded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close navigation"
          onPress={() => setExpanded(false)}
          className="absolute inset-0 bg-black/30"
        />
      ) : null}
      <Animated.View
        className="absolute inset-y-0 left-0 overflow-hidden border-r border-header-border bg-header"
        style={[panelStyle, { paddingTop: insets.top + 8, paddingBottom: insets.bottom }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Close navigation' : 'Open navigation'}
          accessibilityState={{ expanded }}
          android_ripple={{ borderless: true, radius: 24 }}
          onPress={() => setExpanded((current) => !current)}
          className="ml-3 h-12 w-12 items-center justify-center"
        >
          <SymbolView name="line.3.horizontal" size={24} tintColorClassName="accent-header-foreground" />
        </Pressable>
        {hasConnections ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New session"
            onPress={() => {
              setExpanded(false)
              props.onStartNewTask()
            }}
            className="mx-2 mt-2 h-14 flex-row items-center gap-3 rounded-2xl bg-primary px-4"
          >
            <SymbolView name="square.and.pencil" size={24} tintColorClassName="accent-primary-foreground" />
            {expanded ? (
              <Animated.View entering={labelEntering}>
                <Text className="text-sm font-t3-medium text-primary-foreground" numberOfLines={1}>New session</Text>
              </Animated.View>
            ) : null}
          </Pressable>
        ) : null}
        <View accessibilityRole="tablist" className="mt-6 gap-3">
          {DESTINATIONS.map(({ destination, icon, label }) => {
            const active = selected === destination
            return (
              <Pressable
                key={destination}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: active }}
                onPress={() => {
                  setExpanded(false)
                  choose(destination)
                  props.onSelect()
                }}
                className="mx-2 h-12 justify-center"
              >
                <View className={cn('h-8 flex-row items-center gap-3 rounded-full px-4', active && 'bg-secondary')}>
                  <SymbolView name={icon} size={24} tintColorClassName={active ? 'accent-secondary-foreground' : 'accent-header-foreground'} />
                  {expanded ? (
                    <Animated.View entering={labelEntering}>
                      <Text className={cn('text-sm', active ? 'font-t3-bold text-secondary-foreground' : 'font-t3-medium text-header-foreground')} numberOfLines={1}>
                        {label}
                      </Text>
                    </Animated.View>
                  ) : null}
                </View>
              </Pressable>
            )
          })}
        </View>
      </Animated.View>
    </View>
  )
}
