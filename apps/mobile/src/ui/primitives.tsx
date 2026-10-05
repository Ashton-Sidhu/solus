import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View, type TextInputProps } from 'react-native'
import { usePalette } from '../theme/theme'
import { radius, space, TOUCH_TARGET, type } from '../theme/tokens'

/**
 * Controls shared by every native feature. Styles stay beside the element, as
 * Tailwind classes stay in Svelte markup; only the palette is shared.
 */

export function Button({ label, onPress, tone = 'secondary', disabled, busy, accessibilityHint }: {
  label: string
  onPress: () => void
  tone?: 'primary' | 'secondary' | 'danger' | 'plain'
  disabled?: boolean
  busy?: boolean
  accessibilityHint?: string
}) {
  const palette = usePalette()
  const background = tone === 'primary' ? palette.accent : tone === 'danger' ? palette.dangerSoft : tone === 'plain' ? 'transparent' : palette.card
  const color = tone === 'primary' ? palette.onAccent : tone === 'danger' ? palette.danger : tone === 'plain' ? palette.accent : palette.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET,
        paddingHorizontal: space.lg,
        borderRadius: radius.md,
        borderWidth: tone === 'secondary' ? 1 : 0,
        borderColor: palette.border,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: space.sm,
        opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={color} /> : null}
      <Text style={{ color, fontSize: type.chrome, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  )
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  const palette = usePalette()
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ color: palette.textTertiary, fontSize: type.dense, fontWeight: '600' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={palette.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        {...input}
        style={{
          minHeight: TOUCH_TARGET,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: palette.border,
          backgroundColor: palette.surface,
          color: palette.text,
          paddingHorizontal: space.md,
          fontSize: type.body,
        }}
      />
    </View>
  )
}

export function Banner({ message, tone = 'error', action }: { message: string; tone?: 'error' | 'info'; action?: ReactNode }) {
  const palette = usePalette()
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderRadius: radius.md,
        padding: space.md,
        gap: space.sm,
        backgroundColor: tone === 'error' ? palette.dangerSoft : palette.accentSoft,
      }}
    >
      <Text style={{ color: tone === 'error' ? palette.danger : palette.text, fontSize: type.chrome }}>{message}</Text>
      {action}
    </View>
  )
}

export function Card({ children }: { children: ReactNode }) {
  const palette = usePalette()
  return (
    <View style={{ backgroundColor: palette.card, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.border, padding: space.lg, gap: space.md }}>
      {children}
    </View>
  )
}

export function Row({ title, subtitle, onPress, trailing, accessibilityHint }: {
  title: string
  subtitle?: string
  onPress?: () => void
  trailing?: ReactNode
  accessibilityHint?: string
}) {
  const palette = usePalette()
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET + 8,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        backgroundColor: pressed ? palette.accentSoft : 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: palette.border,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: palette.text, fontSize: type.chrome, fontWeight: '500' }}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={{ color: palette.textTertiary, fontSize: type.dense }}>{subtitle}</Text> : null}
      </View>
      {trailing}
    </Pressable>
  )
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  const palette = usePalette()
  return (
    <View style={{ padding: space.xl, gap: space.md, alignItems: 'center' }}>
      <Text accessibilityRole="header" style={{ color: palette.text, fontSize: type.title, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
      <Text style={{ color: palette.textSecondary, fontSize: type.chrome, textAlign: 'center' }}>{message}</Text>
      {action}
    </View>
  )
}

export function StatusDot({ tone }: { tone: 'ok' | 'pending' | 'error' | 'idle' }) {
  const palette = usePalette()
  const color = tone === 'ok' ? '#22a06b' : tone === 'pending' ? palette.accent : tone === 'error' ? palette.danger : palette.textTertiary
  return <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
}
