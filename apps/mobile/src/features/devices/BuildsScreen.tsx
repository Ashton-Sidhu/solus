// Adapted from T3 Code apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx (MIT, see UPSTREAM.md).
import { useState } from 'react'
import { ActionSheetIOS, ActivityIndicator, Alert, Linking, Platform, RefreshControl, ScrollView, View } from 'react-native'
import { isDeviceRunActive, type DeviceBuild, type DeviceRun, type DeviceSummary } from '@solus/contracts/device-types'
import { buildCardSummary, buildDetails, buildDownloadName, buildRunBlocker, deviceBuildTargets, installDeviceBuild } from '@solus/client-core/device-builds'
import { useApp } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { ControlPill, ControlPillMenu } from '../../components/ControlPill'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { cn } from '../../lib/cn'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { deviceErrorText, useDeviceState } from './use-device-state'

/**
 * App builds agents handed to a host (plan 016, S02), in T3 Code's grouped
 * list. An Android phone downloads an APK and installs it itself; any phone
 * can put a build on a simulator or a device connected to the host, add a
 * build output already on the host, or delete a build from it. The host
 * leaves out a build whose output is gone.
 */
type BuildAction = 'download' | 'install' | 'delete'

const BUSY_LABEL = { download: 'Downloading...', install: 'Installing...', delete: 'Deleting...' } satisfies Record<BuildAction, string>

export function BuildsScreen({ navigation, route }: ScreenProps<'Builds'>) {
  const { hostId } = route.params
  const app = useApp()
  const { view, refresh } = useDeviceState(hostId)
  /** The build being downloaded, installed or deleted. One at a time. */
  const [busy, setBusy] = useState<{ buildId: string; action: BuildAction } | null>(null)
  /** Failed New builds the person has read and put away. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const state = view.kind === 'loaded' ? view.state : undefined
  const now = Date.now()

  const installHere = async (build: DeviceBuild) => {
    const connection = app.connections.connection(hostId)
    if (!connection || !build.assetId) return
    setBusy({ buildId: build.buildId, action: 'download' })
    try {
      const signed = await connection.api.assetCreateUrl(undefined, { assetId: build.assetId, name: buildDownloadName(build) })
      // The browser downloads the APK; opening the download starts Android's installer.
      await Linking.openURL(new URL(signed.relativeUrl, `${connection.transport.serverUrl.replace(/\/+$/, '')}/`).toString())
    } catch (cause) {
      Alert.alert('Could not download the build', deviceErrorText(cause))
    } finally {
      setBusy(null)
    }
  }

  const installOn = async (build: DeviceBuild, device: DeviceSummary) => {
    const connection = app.connections.connection(hostId)
    if (!connection || !state) return
    setBusy({ buildId: build.buildId, action: 'install' })
    try {
      const control = state.controls.find((entry) => entry.deviceHostId === device.deviceHostId && entry.deviceId === device.deviceId)
        ?? { deviceHostId: device.deviceHostId, deviceId: device.deviceId, lease: null, agentPaused: false }
      await installDeviceBuild(connection.api, device, build, control, false)
      Alert.alert('Installed', `${build.name} is installed on ${device.name}.`)
    } catch (cause) {
      Alert.alert('The build did not install', deviceErrorText(cause))
    } finally {
      setBusy(null)
    }
  }

  const deleteBuild = (build: DeviceBuild) => {
    const what = build.assetId ? 'the copy of this APK that Solus keeps' : 'this .app bundle'
    Alert.alert(`Delete ${build.name}?`, `This deletes ${what} from the host.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const connection = app.connections.connection(hostId)
          if (!connection) return
          setBusy({ buildId: build.buildId, action: 'delete' })
          connection.api.deviceBuildDelete(build.buildId).then(
            () => refresh(),
            (cause: unknown) => Alert.alert(`Could not delete ${build.name}`, deviceErrorText(cause)),
          ).finally(() => setBusy(null))
        },
      },
    ])
  }

  const chooseDevice = (build: DeviceBuild) => {
    const targets = deviceBuildTargets(state, build)
    if (targets.length === 0) {
      Alert.alert('No device can take this build', buildRunBlocker(state, build) ?? undefined)
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

  const cancelRun = (run: DeviceRun) => {
    app.connections.connection(hostId)?.api.deviceRunCancel(run.runId).catch((cause: unknown) => Alert.alert('Could not cancel the build', deviceErrorText(cause)))
  }

  const showLog = (run: DeviceRun) => {
    app.connections.connection(hostId)?.api.deviceRunLog(run.runId).then(
      (log) => Alert.alert(`${run.profileName} log`, log.text.slice(-1500) || 'No output yet.'),
      (cause: unknown) => Alert.alert('Could not read the log', deviceErrorText(cause)),
    )
  }

  // New builds (runs that install nowhere), from this phone or any client, while they run or after they failed.
  const newBuilds = (state?.runs ?? []).filter((run) => run.deviceId === null && (isDeviceRunActive(run) || run.stage === 'failed') && !dismissed.has(run.runId))
  const builds = state?.builds ?? []
  const unavailableDevices = state?.devices.filter((device) => device.physical && device.unavailableReason) ?? []
  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4, gap: 12 }}
      refreshControl={<RefreshControl refreshing={view.kind === 'loading'} onRefresh={refresh} />}
    >
      <HostStatusBanner hostId={hostId} />
      {view.kind === 'error' ? <ErrorBanner message={view.message} /> : null}
      {!state && view.kind === 'loading' ? (
        <View className="items-center py-16">
          <ActivityIndicator colorClassName="accent-icon" />
          <Text className="mt-3 text-sm text-foreground-muted">Loading builds...</Text>
        </View>
      ) : null}
      {state?.settings.enabled ? (
        <View className="flex-row flex-wrap gap-2">
          <ControlPill variant="primary" label="New build" accessibilityLabel="Build one of a project's build profiles" onPress={() => navigation.push('NewBuild', { hostId })} />
          <ControlPill variant="pill" label="Add existing" accessibilityLabel="Add a build that is already on the host" onPress={() => navigation.push('BuildFolder', { hostId })} />
        </View>
      ) : null}
      {newBuilds.map((run) => {
        const isActive = isDeviceRunActive(run)
        return (
          <View key={run.runId} className="gap-1.5 rounded-[20px] bg-grouped-card px-4 py-3" accessibilityLiveRegion="polite">
            <Text className={cn('text-base font-t3-bold leading-snug', isActive ? 'text-foreground' : 'text-danger-foreground')} numberOfLines={1}>
              {isActive ? `Building ${run.profileName}...` : `${run.profileName} failed`}
            </Text>
            <Text className="text-2xs text-foreground-tertiary" numberOfLines={2}>{[run.checkout, isActive ? run.lastLine : run.error].filter(Boolean).join(' · ')}</Text>
            <View className="flex-row flex-wrap gap-2 pt-1">
              <ControlPill variant="pill" label="Log" accessibilityLabel={`Show the log of ${run.profileName}`} onPress={() => showLog(run)} />
              {isActive ? (
                <ControlPill variant="pill" label="Cancel" accessibilityLabel={`Cancel ${run.profileName}`} onPress={() => cancelRun(run)} />
              ) : (
                <ControlPill variant="pill" label="Dismiss" accessibilityLabel={`Dismiss ${run.profileName}`} onPress={() => setDismissed((current) => new Set([...current, run.runId]))} />
              )}
            </View>
          </View>
        )
      })}
      {state && !state.settings.enabled ? (
        <EmptyState title="Device support is off" detail="Turn on device support for this host in Solus on your computer: Settings → Devices." />
      ) : state && builds.length === 0 ? (
        <EmptyState title="No builds yet" detail="Make one with New build, or ask the agent to build the app. Its builds appear here." />
      ) : builds.length > 0 ? (
        <View className="overflow-hidden rounded-[20px] bg-grouped-card">
          {builds.map((build, index) => {
            const canInstallHere = Platform.OS === 'android' && build.assetId !== null
            const action = busy?.buildId === build.buildId ? busy.action : null
            // The row names the build and what it runs on; its … menu says the rest.
            const details = buildDetails(build, now).map((row) => `${row.label}: ${row.value}`).join('\n')
            return (
              <View key={build.buildId} className={cn('flex-row items-center gap-3 px-4 py-3', index < builds.length - 1 && 'border-b border-separator')}>
                <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-subtle">
                  <SymbolView name="hammer" size={15} tintColorClassName="accent-icon-subtle" type="monochrome" />
                </View>
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-base font-t3-bold leading-snug text-foreground" numberOfLines={1}>{build.name}</Text>
                  <Text className="text-2xs text-foreground-tertiary" numberOfLines={1}>{buildCardSummary(build, now)}</Text>
                </View>
                <ControlPill
                  variant="pill"
                  label={action ? BUSY_LABEL[action] : 'Run'}
                  accessibilityLabel={`Install ${build.name} on a device connected to the host`}
                  disabled={busy !== null}
                  onPress={() => chooseDevice(build)}
                />
                <ControlPillMenu
                  accessibilityLabel={`More for ${build.name}`}
                  title={details}
                  actions={[
                    ...(canInstallHere ? [{ id: 'download', title: 'Install on this phone', image: Platform.OS === 'ios' ? 'arrow.down.circle' : 'download' }] : []),
                    { id: 'delete', title: 'Delete…', image: Platform.OS === 'ios' ? 'trash' : 'delete', attributes: { destructive: true } },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (busy) return
                    if (nativeEvent.event === 'download') void installHere(build)
                    if (nativeEvent.event === 'delete') deleteBuild(build)
                  }}
                >
                  <ControlPill icon="ellipsis" accessibilityLabel={`More for ${build.name}`} disabled={busy !== null} />
                </ControlPillMenu>
              </View>
            )
          })}
        </View>
      ) : null}
      {unavailableDevices.map((device) => (
        <Text key={`${device.deviceHostId}:${device.deviceId}`} className="px-1 text-xs leading-snug text-foreground-muted">
          {device.unavailableReason}
        </Text>
      ))}
      {Platform.OS === 'android' ? (
        <Text className="px-1 text-xs leading-snug text-foreground-muted">
          The first time, Android asks you to allow installs from your browser.
        </Text>
      ) : null}
    </ScrollView>
  )
}
