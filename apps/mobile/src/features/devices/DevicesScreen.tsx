import { useCallback, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { DevicePreview, DeviceSummary } from '@solus/contracts/device-types'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { ScreenScrollView } from '../../components/ScreenScrollView'
import type { ScreenProps } from '../../navigation/routes'
import { SettingsScreen } from '../settings/components/SettingsScreen'
import { DeviceCatalog } from './DeviceCatalog'
import { threadDevicePreviews } from './threadDevicePreviews'

/** The host's devices: open one in the session, or watch one it already shows in the device viewer. */
export function DevicesScreen({ route, navigation }: ScreenProps<'Devices'>) {
  const { hostId, sessionId } = route.params
  const app = useApp()
  const state = useListened(app.devices.changes, () => app.devices.stateOf(hostId))
  const error = useListened(app.devices.changes, () => app.devices.errorOf(hostId))
  const [busy, setBusy] = useState(false)
  const previews = state?.previews.filter((preview) => !sessionId || preview.sessionId === sessionId) ?? []
  useFocusEffect(useCallback(() => { void app.devices.load(hostId, true) }, [app, hostId]))
  async function run(work: () => Promise<void>) {
    setBusy(true)
    try { await work() } catch (cause) { Alert.alert('Devices', cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  function watch(preview: DevicePreview) {
    const key = threadDevicePreviews(state, preview.sessionId).find((entry) => entry.preview.devicePreviewId === preview.devicePreviewId)?.key
    navigation.navigate('ThreadDevicePreview', { hostId, sessionId: preview.sessionId, deviceKey: key })
  }
  function open(device: DeviceSummary) {
    if (!sessionId) return
    void run(async () => { watch(await app.devices.open(hostId, sessionId, device)) })
  }
  return <SettingsScreen title="Devices" actions={[{ icon: 'gearshape', accessibilityLabel: 'Device settings', onPress: () => navigation.navigate('DeviceSettings', { hostId }) }]}>
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 p-5" className="flex-1">
      {error ? <Text accessibilityRole="alert" className="text-base text-danger-foreground">{error}</Text> : null}
      {previews.length > 0 ? <View className="flex-row flex-wrap gap-2">{previews.map((preview) => <Pressable accessibilityRole="button" accessibilityHint="Opens the device viewer" key={preview.devicePreviewId} onPress={() => watch(preview)} className="rounded-xl bg-grouped-card px-3 py-2"><Text className="text-base text-foreground">{state?.devices.find((device) => device.deviceHostId === preview.deviceHostId && device.deviceId === preview.deviceId)?.name ?? preview.platform}</Text></Pressable>)}</View> : null}
      <DeviceCatalog state={state} previews={previews} hasSession={!!sessionId} busy={busy} onSettings={() => navigation.navigate('DeviceSettings', { hostId })} onRefresh={() => void app.devices.load(hostId, true)} onOpen={open} />
    </ScreenScrollView>
  </SettingsScreen>
}
