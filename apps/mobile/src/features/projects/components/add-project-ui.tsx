// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps, ReactNode } from 'react'
import { ActivityIndicator, Platform, Pressable, RefreshControl, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text, AppTextInput as TextInput, type AppTextInputProps } from '../../../components/AppText'
import { MaterialButton } from '../../../components/MaterialButton'
import { MaterialListRow } from '../../../components/MaterialListRow'
import { ScreenScrollView as ScrollView } from '../../../components/ScreenScrollView'
import { cn } from '../../../lib/cn'

/** The icon size of a list row on each platform. */
export const LIST_ROW_ICON_SIZE = Platform.OS === 'android' ? 24 : 17

export function SectionTitle(props: { readonly children: string }) {
  return (
    <Text
      accessibilityRole="header"
      className={
        Platform.OS === 'android'
          ? 'px-4 text-sm font-t3-medium text-primary-text'
          : 'px-1 text-2xs font-t3-bold tracking-[0.7px] uppercase text-foreground-muted'
      }
    >
      {props.children}
    </Text>
  )
}

export function AddProjectShell(props: { readonly children: ReactNode; readonly onRefresh?: () => void; readonly refreshing?: boolean }) {
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      className="flex-1 bg-sheet"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={props.onRefresh ? <RefreshControl refreshing={props.refreshing ?? false} onRefresh={props.onRefresh} /> : undefined}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === 'android' ? 16 : 20,
        paddingTop: 16,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        gap: Platform.OS === 'android' ? 16 : 10,
      }}
    >
      {props.children}
    </ScrollView>
  )
}

export function ListSection(props: { readonly children: ReactNode }) {
  return (
    <View className={Platform.OS === 'android' ? 'overflow-hidden rounded-[28px] bg-grouped-card' : 'overflow-hidden rounded-[24px] bg-grouped-card'}>
      {props.children}
    </View>
  )
}

/** A symbol in a list row's leading slot. */
export function ListRowSymbol(props: { readonly name: ComponentProps<typeof SymbolView>['name']; readonly muted?: boolean }) {
  return (
    <SymbolView
      name={props.name}
      size={LIST_ROW_ICON_SIZE}
      tintColorClassName={props.muted ? 'accent-icon-muted' : 'accent-icon'}
      type="monochrome"
    />
  )
}

export function ListRow(props: {
  readonly title: string
  readonly subtitle?: string | null
  readonly icon: ReactNode
  readonly disabled?: boolean
  readonly isFirst?: boolean
  readonly right?: ReactNode
  readonly accessibilityHint?: string
  readonly onPress?: () => void
}) {
  if (Platform.OS === 'android') {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.title}
        subtitle={props.subtitle}
        leading={props.icon}
        trailing={props.right}
        disabled={props.disabled}
        onPress={props.onPress}
        accessibilityHint={props.accessibilityHint}
      />
    )
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={props.accessibilityHint}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        'bg-grouped-card px-3.5 py-2.5 active:opacity-70',
        !props.isFirst && 'border-t border-border-subtle',
        props.disabled && 'opacity-[0.45]',
      )}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-7 w-7 items-center justify-center">{props.icon}</View>
        <View className="flex-1 gap-0.5">
          <Text className="text-base leading-snug font-t3-bold">{props.title}</Text>
          {props.subtitle ? (
            <Text className="text-sm leading-snug text-foreground-muted" numberOfLines={2}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
        {'right' in props ? (
          props.right
        ) : !props.disabled ? (
          <SymbolView name="chevron.right" size={13} tintColorClassName="accent-chevron" type="monochrome" />
        ) : null}
      </View>
    </Pressable>
  )
}

export function PrimaryActionButton(props: {
  readonly label: string
  readonly disabled?: boolean
  readonly loading?: boolean
  readonly onPress: () => void
}) {
  if (Platform.OS === 'android') return <MaterialButton {...props} tone="primary" fullWidth />
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-12 items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-45"
    >
      {props.loading ? (
        <ActivityIndicator colorClassName="accent-primary-foreground" />
      ) : (
        <Text className="text-base font-t3-bold text-primary-foreground">{props.label}</Text>
      )}
    </Pressable>
  )
}

/** T3 Code's single-line project field. */
export function AddProjectTextInput(props: AppTextInputProps) {
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      className={cn('h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug', props.className)}
    />
  )
}

/** T3 Code's centered state card, used for loading, empty, and missing states. */
export function ListStateCard(props: { readonly title: string; readonly detail?: string; readonly actionLabel?: string; readonly onAction?: () => void; readonly loading?: boolean }) {
  return (
    <View className="items-center gap-3 rounded-2xl bg-grouped-card px-5 py-8">
      {props.loading ? <ActivityIndicator colorClassName="accent-icon-muted" /> : null}
      <Text className="text-center text-lg font-t3-bold">{props.title}</Text>
      {props.detail ? <Text className="text-center text-sm leading-normal text-foreground-muted">{props.detail}</Text> : null}
      {props.actionLabel && props.onAction ? (
        <Pressable accessibilityRole="button" onPress={props.onAction} className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70">
          <Text className="text-sm font-t3-bold text-primary-foreground">{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
