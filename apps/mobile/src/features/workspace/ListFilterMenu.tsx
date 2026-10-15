// Adapted from T3 Code apps/mobile/src/features/workspace/ListFilterMenu.tsx (MIT, see UPSTREAM.md).
import { Pressable, View } from 'react-native'
import { AppText as Text } from '../../components/AppText'
import { SymbolView } from '../../components/AppSymbol'
import { ControlPillMenu } from '../../components/ControlPillMenu'
import type { ControlPillMenuProps } from '../../components/ControlPillMenu.types'
import { cn } from '../../lib/cn'

/** A visible filter with a native menu containing only that filter's choices. */
export function ListFilterMenu(props: {
  readonly label: string
  readonly accessibilityLabel: string
  readonly active?: boolean
  readonly icon?: boolean
  readonly actions: ControlPillMenuProps['actions']
  readonly onSelect: (id: string) => void
}) {
  const content = (
    <>
      {props.icon ? (
        <SymbolView name="line.3.horizontal.decrease" size={15} tintColorClassName={props.active ? 'accent-primary-foreground' : 'accent-icon-muted'} />
      ) : null}
      <Text numberOfLines={1} className={cn('max-w-[180px] text-sm font-t3-medium', props.active ? 'text-primary-foreground' : 'text-foreground-muted')}>
        {props.label}
      </Text>
      {!props.icon ? (
        <SymbolView name="chevron.down" size={11} tintColorClassName={props.active ? 'accent-primary-foreground' : 'accent-icon-muted'} />
      ) : null}
    </>
  )
  return (
    <ControlPillMenu title={props.accessibilityLabel} actions={props.actions} onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}>
      <Pressable accessibilityRole="button" accessibilityLabel={props.accessibilityLabel} hitSlop={6}>
        {/* Native glass casts a shadow that is clipped into a gray strip by the filter scroll view. */}
        <View className={cn('h-8 flex-row items-center gap-1.5 rounded-full px-3', props.active && 'bg-primary')}>
          {content}
        </View>
      </Pressable>
    </ControlPillMenu>
  )
}
