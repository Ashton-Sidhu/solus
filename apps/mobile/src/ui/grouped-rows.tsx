import type { ComponentProps, ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from 'react-native'
import { usePalette } from '../theme/theme'
import { TOUCH_TARGET } from '../theme/tokens'
import { AppSymbol, type AppSymbolName } from './app-symbol'

/**
 * Grouped rows in the shape of T3 Code's iOS settings
 * (`apps/mobile/src/features/settings/components/`, see UPSTREAM.md): a
 * sentence-case title over a 24px card, 14px row padding, 18px labels, and no
 * separators between plain rows. Colors are Solus's.
 */

export function GroupedScroll({ children, gap = 21, refreshControl }: {
  children: ReactNode
  /** 14 on the root screen, 21 on a sub-screen. */
  gap?: number
  refreshControl?: ComponentProps<typeof ScrollView>['refreshControl']
}) {
  const palette = usePalette()
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      style={{ backgroundColor: palette.canvas }}
      contentContainerStyle={{ paddingHorizontal: 17.5, paddingTop: 14, paddingBottom: 36, gap }}
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  )
}

export function GroupedSection({ title, trailing, footer, children }: {
  title?: string
  trailing?: ReactNode
  /** The note under the card: what the section changes, or why it cannot. */
  footer?: string
  children: ReactNode
}) {
  const palette = usePalette()
  return (
    <View style={{ gap: 10.5 }}>
      <View style={{ gap: 7 }}>
        {title ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10.5, paddingHorizontal: 7 }}>
            <Text accessibilityRole="header" style={{ color: palette.textTertiary, fontSize: 14, lineHeight: 19, fontWeight: '500' }}>{title}</Text>
            {trailing}
          </View>
        ) : null}
        <View style={{ borderRadius: 24, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: palette.card }}>{children}</View>
      </View>
      {footer ? <GroupedFooter text={footer} /> : null}
    </View>
  )
}

export function GroupedFooter({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'danger' }) {
  const palette = usePalette()
  return (
    <Text style={{ paddingHorizontal: 7, color: tone === 'danger' ? palette.danger : palette.textTertiary, fontSize: 14, lineHeight: 21 }}>{text}</Text>
  )
}

/** A row that opens a screen: label, the current value, and a chevron. */
export function NavigationRow({ icon, label, value, onPress, disabled, accessibilityHint }: {
  /** The 22px symbol before the label, as T3 Code's settings rows. */
  icon?: AppSymbolName
  label: string
  value?: string
  onPress: () => void
  disabled?: boolean
  accessibilityHint?: string
}) {
  const palette = usePalette()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET + 7,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: pressed ? palette.accentSoft : 'transparent',
      })}
    >
      {icon ? <AppSymbol name={icon} /> : null}
      <Text numberOfLines={1} style={{ flexShrink: 0, color: palette.text, fontSize: 18, lineHeight: 23 }}>{label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        {value ? <Text numberOfLines={1} ellipsizeMode="middle" style={{ maxWidth: 180, color: palette.textTertiary, fontSize: 16, lineHeight: 23, textAlign: 'right' }}>{value}</Text> : null}
      </View>
      <AppSymbol name="chevronRight" size={16} weight="semibold" color={palette.textTertiary} />
    </Pressable>
  )
}

/** A label, an optional line under it, and a switch. */
export function SwitchRow({ icon, label, subtitle, value, onChange, disabled }: {
  icon?: AppSymbolName
  label: string
  subtitle?: string
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  const palette = usePalette()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, opacity: disabled ? 0.45 : 1 }}>
      {icon ? <AppSymbol name={icon} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: palette.text, fontSize: 18, lineHeight: 23 }}>{label}</Text>
        {subtitle ? <Text style={{ color: palette.textTertiary, fontSize: 14, lineHeight: 19 }}>{subtitle}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: palette.accent, false: palette.border }}
        ios_backgroundColor={palette.border}
      />
    </View>
  )
}

/** One of several choices; the chosen one carries a check. Rows after the
 *  first are divided by a hairline. */
export function ChoiceRow({ label, description, selected, onPress, isFirst, disabled }: {
  label: string
  description?: string
  selected: boolean
  onPress: () => void
  isFirst: boolean
  disabled?: boolean
}) {
  const palette = usePalette()
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        borderTopWidth: isFirst ? 0 : 1,
        borderTopColor: palette.border,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 3.5 }}>
        <Text style={{ color: palette.text, fontSize: 18, lineHeight: 23 }}>{label}</Text>
        {description ? <Text style={{ color: palette.textTertiary, fontSize: 14, lineHeight: 21 }}>{description}</Text> : null}
      </View>
      {selected ? <AppSymbol name="checkmark" size={18} weight="semibold" color={palette.accent} /> : null}
    </Pressable>
  )
}

/** An action, not a destination: no chevron. Danger rows read in red. */
export function ActionRow({ icon, label, onPress, tone = 'default', busy, disabled, isFirst = true }: {
  icon?: AppSymbolName
  label: string
  onPress: () => void
  tone?: 'default' | 'accent' | 'danger'
  busy?: boolean
  disabled?: boolean
  isFirst?: boolean
}) {
  const palette = usePalette()
  const color = tone === 'danger' ? palette.danger : tone === 'accent' ? palette.accent : palette.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET + 7,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        borderTopWidth: isFirst ? 0 : 1,
        borderTopColor: palette.border,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: pressed ? palette.accentSoft : 'transparent',
      })}
    >
      {icon ? <AppSymbol name={icon} color={color} /> : null}
      <Text style={{ flex: 1, color, fontSize: 18, lineHeight: 23 }}>{label}</Text>
      {busy ? <ActivityIndicator /> : null}
    </Pressable>
  )
}

/** A fact the person reads but does not change. */
export function ValueRow({ label, value, detail, isFirst = true }: { label: string; value: string; detail?: string; isFirst?: boolean }) {
  const palette = usePalette()
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${value}${detail ? `, ${detail}` : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: isFirst ? 0 : 1, borderTopColor: palette.border }}
    >
      <Text style={{ color: palette.text, fontSize: 18, lineHeight: 23 }}>{label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end', gap: 2 }}>
        <Text selectable numberOfLines={1} ellipsizeMode="middle" style={{ color: palette.textTertiary, fontSize: 16, lineHeight: 23 }}>{value}</Text>
        {detail ? <Text style={{ color: palette.textTertiary, fontSize: 13, opacity: 0.7 }}>{detail}</Text> : null}
      </View>
    </View>
  )
}
