import { useState } from 'react'
import { ActionSheetIOS, Alert, Linking, Platform, RefreshControl, ScrollView, Text, View } from 'react-native'
import type { DeviceBuild, DeviceSummary } from '@solus/contracts/device-types'
import { buildDownloadName, buildSummary, deviceBuildTargets, installDeviceBuild, lastInstallLabel } from '@solus/client-core/device-builds'
import { useApp } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space, type } from '../../theme/tokens'
import { Banner, Button, EmptyState, Row } from '../../ui/primitives'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { deviceErrorText, useDeviceState } from './use-device-state'

/**
 * App builds agents handed to a host (plan 016, S02). An Android phone
 * downloads an APK and installs it itself; any phone can put a build on a
 * simulator or a device connected to the host.
 */
export function BuildsScreen({ route }: ScreenProps<'Builds'>) {
  const { hostId } = route.params
  const app = useApp()
  const palette = usePalette()
  const { view, refresh } = useDeviceState(hostId)
  const [busyBuildId, setBusyBuildId] = useState<string | null>(null)
  const state = view.kind === 'loaded' ? view.state : undefined
  const now = Date.now()

  const installHere = async (build: DeviceBuild) => {
    const connection = app.connections.connection(hostId)
    if (!connection || !build.assetId) return
    setBusyBuildId(build.buildId)
    try {
      const signed = await connection.api.assetCreateUrl(undefined, { assetId: build.assetId, name: buildDownloadName(build) })
      // The browser downloads the APK; opening the download starts Android's installer.
      await Linking.openURL(new URL(signed.relativeUrl, `${connection.transport.serverUrl.replace(/\/+$/, '')}/`).toString())
    } catch (cause) {
      Alert.alert('Could not download the build', deviceErrorText(cause))
    } finally {
      setBusyBuildId(null)
    }
  }

  const installOn = async (build: DeviceBuild, device: DeviceSummary) => {
    const connection = app.connections.connection(hostId)
    if (!connection || !state) return
    setBusyBuildId(build.buildId)
    try {
      const control = state.controls.find((entry) => entry.deviceHostId === device.deviceHostId && entry.deviceId === device.deviceId)
        ?? { deviceHostId: device.deviceHostId, deviceId: device.deviceId, lease: null, agentPaused: false }
      await installDeviceBuild(connection.api, device, build, control, null)
      Alert.alert('Installed', `${build.name} is installed on ${device.name}.`)
    } catch (cause) {
      Alert.alert('The build did not install', deviceErrorText(cause))
    } finally {
      setBusyBuildId(null)
    }
  }

  const chooseDevice = (build: DeviceBuild) => {
    const targets = deviceBuildTargets(state, build)
    if (targets.length === 0) {
      Alert.alert('No device can take this build', `Connect a phone to the host, or open a ${build.platform === 'ios' ? 'simulator' : 'emulator'} there first.`)
      return
    }
    const labels = targets.map((device) => `${device.name}${device.physical ? '' : ' (simulator)'}`)
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: `Install ${build.name} on`, options: [...labels, 'Cancel'], cancelButtonIndex: labels.length }, (index) => {
        const device = targets[index]
        if (device) void installOn(build, device)
      })
      return
    }
    Alert.alert(`Install ${build.name} on`, undefined, [
      ...targets.slice(0, 2).map((device, index) => ({ text: labels[index]!, onPress: () => void installOn(build, device) })),
      { text: 'Cancel', style: 'cancel' as const },
    ])
  }

  const builds = state?.builds ?? []
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      refreshControl={<RefreshControl refreshing={view.kind === 'loading'} onRefresh={refresh} />}
    >
      <HostStatusBanner hostId={hostId} />
      {view.kind === 'error' ? <View style={{ padding: space.lg }}><Banner message={view.message} /></View> : null}
      {state && !state.settings.enabled ? (
        <EmptyState title="Device support is off" message="Turn on device support for this host in Solus on your computer: Settings → Devices." />
      ) : state && builds.length === 0 ? (
        <EmptyState title="No builds yet" message="Ask the agent to build the app and put it on your phone. Its builds appear here." />
      ) : (
        builds.map((build) => {
          const canInstallHere = Platform.OS === 'android' && build.assetId !== null
          return (
            <Row
              key={build.buildId}
              title={build.name}
              subtitle={[buildSummary(build, now), lastInstallLabel(build, now)].filter(Boolean).join(' · ')}
              trailing={<View style={{ flexDirection: 'row', gap: space.xs }}>
                {canInstallHere ? <Button tone="primary" label="Install here" busy={busyBuildId === build.buildId} accessibilityHint="Downloads the APK so Android can install it on this phone" onPress={() => void installHere(build)} /> : null}
                <Button tone="plain" label="Install on…" disabled={busyBuildId !== null} accessibilityHint="Installs it on a device connected to the host" onPress={() => chooseDevice(build)} />
              </View>}
            />
          )
        })
      )}
      {state?.devices.filter((device) => device.physical && device.unavailableReason).map((device) => (
        <Text key={`${device.deviceHostId}:${device.deviceId}`} style={{ color: palette.textTertiary, fontSize: type.dense, paddingHorizontal: space.lg, paddingTop: space.sm }}>
          {device.unavailableReason}
        </Text>
      ))}
      {Platform.OS === 'android' ? (
        <Text style={{ color: palette.textTertiary, fontSize: type.dense, padding: space.lg }}>
          The first time, Android asks you to allow installs from your browser.
        </Text>
      ) : null}
    </ScrollView>
  )
}
