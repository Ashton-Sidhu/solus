import { isValidElement, type ReactNode } from 'react'
import { Pressable, TextInput, View, type TextInputProps } from 'react-native'
import { AppText as Text } from './AppText'

export function ActionButton({
  children,
  onPress,
  disabled,
  selected
}: {
  children: ReactNode
  onPress: () => void
  disabled?: boolean
  selected?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-12 justify-center rounded-xl px-3 py-2 disabled:opacity-40 ${selected ? 'bg-secondary' : 'bg-grouped-card'}`}
    >
      {isValidElement(children) ? (
        children
      ) : (
        <Text className="text-sm text-foreground">{children}</Text>
      )}
    </Pressable>
  )
}
export function FormField({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        {...props}
        className="min-h-12 rounded-xl border border-border bg-grouped-card px-3 py-2 text-base text-foreground"
      />
    </View>
  )
}
