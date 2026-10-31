import { useCallback, useEffect, useState } from 'react'
import { AppState, Alert, Linking, Pressable, View } from 'react-native'
import { useFocusEffect, useIsFocused } from '@react-navigation/native'
import type { DeviceInput, DevicePreview as Preview, DeviceSummary } from '@solus/contracts/device-types'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { ScreenScrollView } from '../../components/ScreenScrollView'
import type { ScreenProps } from '../../navigation/routes'
import { SettingsScreen } from '../settings/components/SettingsScreen'
import { DeviceCatalog } from './DeviceCatalog'
import { DevicePreviewControls } from './DevicePreviewControls'
import { DevicePreview } from './DevicePreview'

export function DevicesScreen({ route, navigation }: ScreenProps<'Devices'>) {
  const { hostId, sessionId } = route.params
  const app = useApp()
  const state = useListened(app.devices.changes, () => app.devices.stateOf(hostId))
  const error = useListened(app.devices.changes, () => app.devices.errorOf(hostId))
  const focused = useIsFocused()
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState<DeviceInput | null>(null)
  const previews = state?.previews.filter((preview) => !sessionId || preview.sessionId === sessionId) ?? []
  const preview = previews.find((candidate) => candidate.devicePreviewId === selected) ?? previews[0]
  const host = state?.hosts.find((candidate) => candidate.deviceHostId === preview?.deviceHostId)
  const control = state?.controls.find((entry) => entry.deviceHostId === preview?.deviceHostId && entry.deviceId === preview?.deviceId)
  const ownsControl = preview ? app.devices.holdsControl(hostId, preview) : false
  useEffect(() => { const sub = AppState.addEventListener('change', (next) => setForeground(next === 'active')); return () => sub.remove() }, [])
  useFocusEffect(useCallback(() => { void app.devices.load(hostId, true) }, [app, hostId]))
  // Only the visible manual controller renews its grant. A takeover elsewhere ends it.
  useEffect(() => {
    if (!focused || !foreground || !preview || !ownsControl) return
    const timer = setInterval(() => { if (app.devices.holdsControl(hostId, preview)) void app.devices.takeControl(hostId, preview, preview.sessionId).catch(() => {}) }, 10_000)
    return () => { clearInterval(timer); if (app.devices.holdsControl(hostId, preview)) void app.devices.release(hostId, preview).catch(() => {}) }
  }, [app, focused, foreground, hostId, preview?.devicePreviewId, ownsControl])
  async function run(work: () => Promise<void>) {
    setBusy(true)
    try { await work() } catch (cause) { Alert.alert('Devices', cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  function open(device: DeviceSummary) {
    if (!sessionId) return
    void run(async () => { const opened = await app.devices.open(hostId, sessionId, device); setSelected(opened.devicePreviewId) })
  }
  function close(target: Preview) { void run(() => app.devices.close(hostId, target.sessionId, target)) }
  return <SettingsScreen title="Devices" actions={[{ icon: 'gearshape', accessibilityLabel: 'Device settings', onPress: () => navigation.navigate('DeviceSettings', { hostId }) }]}>
    {preview && focused && foreground ? <View className="min-h-0 flex-1 gap-2 p-3">
      <View className="flex-row flex-wrap gap-2">{previews.map((candidate) => <Pressable accessibilityRole="button" key={candidate.devicePreviewId} onPress={() => setSelected(candidate.devicePreviewId)} className="rounded-xl bg-grouped-card px-3 py-2"><Text className="text-base text-foreground">{state?.devices.find((device) => device.deviceHostId === candidate.deviceHostId && device.deviceId === candidate.deviceId)?.name ?? candidate.platform}</Text></Pressable>)}</View>
      <DevicePreview key={preview.devicePreviewId} hostId={hostId} preview={preview} kind={host?.kind ?? 'local'} enabled={ownsControl} input={input} />
      <DevicePreviewControls platform={preview.platform} kind={host?.kind ?? 'local'} ownsControl={ownsControl} control={control} busy={busy} onInput={setInput}
        onControl={() => void run(() => ownsControl ? app.devices.release(hostId, preview) : app.devices.takeControl(hostId, preview, preview.sessionId))}
        onResume={() => void run(() => app.devices.resume(hostId, preview))}
        onScreenshot={() => void run(async () => { await Linking.openURL(await app.devices.screenshotUrl(hostId, preview)) })}
        onClose={() => close(preview)} />
    </View> : null}
    <ScreenScrollView contentContainerClassName="gap-4 p-5" className={preview ? 'max-h-48' : 'flex-1'}>
      {error ? <Text accessibilityRole="alert" className="text-base text-danger-foreground">{error}</Text> : null}
      <DeviceCatalog state={state} previews={previews} hasSession={!!sessionId} busy={busy} onSettings={() => navigation.navigate('DeviceSettings', { hostId })} onRefresh={() => void app.devices.load(hostId, true)} onOpen={open} />
    </ScreenScrollView>
  </SettingsScreen>
}
