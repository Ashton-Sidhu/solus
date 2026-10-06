// Adapted from T3 Code apps/mobile/src/features/threads/git/gitSheetComponents.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps, ReactNode } from 'react'
import { Platform, Pressable, View } from 'react-native'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { cn } from '../../../lib/cn'
import { CODE_FONT } from '../../../theme/tokens'

/** T3 Code's sheet card: rows on the card color, rounded, with a hairline border on iOS. */
export function SheetCard(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <View className={cn('overflow-hidden bg-card android:rounded-[20px] ios:rounded-[22px] ios:border ios:border-border ios:px-4 ios:py-1', props.className)}>
      {props.children}
    </View>
  )
}

/** The label above a card, as T3 Code's "Linked pull requests". */
export function SheetSectionLabel(props: { readonly children: string }) {
  return (
    <Text accessibilityRole="header" className="px-1 text-xs font-t3-bold text-foreground-muted">
      {props.children}
    </Text>
  )
}

/** The hairline between two rows of a card; Android separates rows by their ripple. */
export function SheetRowDivider(props: { readonly inset?: boolean }) {
  if (Platform.OS === 'android') return null
  return <View className={cn('h-px bg-border', props.inset !== false && 'ml-12')} />
}

export function MetaCard(props: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <View className="bg-card px-4 py-3 android:rounded-[20px] ios:rounded-[18px] ios:border ios:border-border">
      <Text className="text-foreground-muted text-2xs font-t3-bold tracking-[0.9px] uppercase">{props.label}</Text>
      <Text selectable className="text-foreground text-sm font-medium" style={props.mono ? { fontFamily: CODE_FONT } : undefined} numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  )
}

export function SheetListRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>['name']
  readonly iconTintClassName?: string
  readonly title: string
  readonly subtitle?: string | null
  readonly disabled?: boolean
  readonly accessibilityHint?: string
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={props.accessibilityHint}
      className="flex-row items-center py-3 disabled:opacity-[0.45] android:min-h-16 android:gap-4 android:px-4 android:active:bg-subtle ios:gap-3 ios:px-1"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className="items-center justify-center android:size-6 ios:bg-subtle ios:h-9 ios:w-9 ios:rounded-full">
        <SymbolView
          name={props.icon}
          size={Platform.OS === 'android' ? 24 : 16}
          tintColorClassName={props.iconTintClassName ?? 'accent-icon'}
          type="monochrome"
        />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-foreground text-base android:font-t3-medium ios:font-t3-bold">{props.title}</Text>
        {props.subtitle ? <Text className="text-foreground-muted text-xs leading-snug">{props.subtitle}</Text> : null}
      </View>
      {Platform.OS !== 'android' ? (
        <SymbolView name="chevron.right" size={13} tintColorClassName="accent-icon-subtle" type="monochrome" />
      ) : null}
    </Pressable>
  )
}

/** A label and a value in one card row; tappable when it opens something. */
export function SheetValueRow(props: {
  readonly label: string
  readonly value: string
  readonly valueClassName?: string
  readonly mono?: boolean
  readonly onPress?: () => void
}) {
  const content = (
    <>
      <Text
        className={cn('min-w-0 flex-1 text-sm text-foreground', props.mono && 'text-xs')}
        style={props.mono ? { fontFamily: CODE_FONT } : undefined}
        numberOfLines={1}
        ellipsizeMode={props.mono ? 'head' : 'tail'}
      >
        {props.label}
      </Text>
      <Text className={cn('text-xs font-t3-medium text-foreground-muted', props.valueClassName)}>{props.value}</Text>
      {props.onPress && Platform.OS !== 'android' ? (
        <SymbolView name="chevron.right" size={13} tintColorClassName="accent-icon-subtle" type="monochrome" />
      ) : null}
    </>
  )
  const className = 'min-h-11 flex-row items-center gap-3 py-2.5 android:px-4 ios:px-1'
  return props.onPress ? (
    <Pressable accessibilityRole="button" onPress={props.onPress} className={cn(className, 'android:active:bg-subtle ios:active:opacity-70')}>
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  )
}
