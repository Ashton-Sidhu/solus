import { useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import type { DeviceInput, DevicePlatform, DeviceControlState } from '@solus/contracts/device-types'
import { AppText as Text } from '../../components/AppText'

export function DevicePreviewControls(props: {
  platform: DevicePlatform
  kind: 'local' | 'ssh' | 'eas' | 'simlock'
  ownsControl: boolean
  control: DeviceControlState | undefined
  busy: boolean
  onControl: () => void
  onResume: () => void
  onScreenshot: () => void
  onClose: () => void
  onInput: (input: DeviceInput) => void
}) {
  const [text, setText] = useState('')
  const buttons = props.platform === 'android' ? ['home', 'back', 'recents'] as const : ['home', 'appSwitcher'] as const
  const label = props.ownsControl ? 'You control this device.' : props.control?.lease ? `${props.control.lease.holder.label} controls this device.` : 'Take control to interact.'
  const closeLabel = props.kind === 'simlock' ? 'Return to pool' : props.kind === 'eas' ? 'Stop session' : 'Close preview'
  return <View className="gap-2">
    <Text className="text-base text-foreground-muted">{label}</Text>
    <View className="flex-row flex-wrap gap-2">
      <Pressable accessibilityRole="button" disabled={props.busy} onPress={props.onControl} className="rounded-xl bg-grouped-card px-3 py-3"><Text className="text-base text-foreground">{props.ownsControl ? 'Release control' : 'Take control'}</Text></Pressable>
      {props.control?.agentPaused ? <Pressable accessibilityRole="button" disabled={props.busy} onPress={props.onResume} className="rounded-xl bg-grouped-card px-3 py-3"><Text className="text-base text-foreground">Resume agent</Text></Pressable> : null}
      {buttons.map((button) => <Pressable accessibilityRole="button" key={button} disabled={!props.ownsControl} onPress={() => props.onInput({ kind: 'button', button })} className="rounded-xl bg-grouped-card px-3 py-3 disabled:opacity-40"><Text className="text-base text-foreground">{button === 'appSwitcher' ? 'App switcher' : button[0]!.toUpperCase() + button.slice(1)}</Text></Pressable>)}
      {props.kind !== 'simlock' ? <Pressable accessibilityRole="button" disabled={props.busy} onPress={props.onScreenshot} className="rounded-xl bg-grouped-card px-3 py-3"><Text className="text-base text-foreground">Screenshot</Text></Pressable> : null}
      <Pressable accessibilityRole="button" disabled={props.busy} onPress={props.onClose} className="rounded-xl bg-grouped-card px-3 py-3"><Text className="text-base text-foreground">{closeLabel}</Text></Pressable>
    </View>
    <View className="flex-row items-center gap-2"><TextInput accessibilityLabel="Type on the device" placeholder="Type on the device" value={text} onChangeText={setText} editable={props.ownsControl} className="min-w-0 flex-1 rounded-xl border border-border p-3 text-base text-foreground" /><Pressable accessibilityRole="button" disabled={!props.ownsControl || !text} onPress={() => { props.onInput({ kind: 'text', text }); setText('') }} className="p-3"><Text className="text-base text-foreground">Send</Text></Pressable></View>
  </View>
}
