import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { isChat } from '@solus/contracts/chat'
import { isDeviceRunActive, type DeviceRun, type DeviceRunMode, type DeviceRunStartRequest, type DeviceSummary } from '@solus/contracts/device-types'
import { ANDROID_DOWNLOAD_TARGET, runDeviceSelectionId, runStageLabel, buildDownloadName, installDeviceBuild, startDeviceRun } from '@solus/client-core/device-builds'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { ControlPill, ControlPillMenu } from '../../components/ControlPill'
import { SymbolView, type AppSymbolName } from '../../components/AppSymbol'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { ConnectCardTile, connectCardClassName } from '../connection/ConnectOptionCard'
import { deviceErrorText, useDeviceState } from './use-device-state'

/** Run app on a host. Downloads never report a confirmed phone install. */
export function RunAppScreen({ navigation, route }: ScreenProps<'RunApp'>) {
  const { hostId, sessionId, conversationCheckoutPath } = route.params
  const app = useApp()
  const { view, refresh } = useDeviceState(hostId)
  const allProjects = useListened(app.threads.changes, app.threads.projects)
  const projects = allProjects.filter((entry) => entry.hostId === hostId && !isChat(entry.project.path))
  const [projectPath, setProjectPath] = useState(route.params.projectPath ?? '')
  const [source, setSource] = useState<'main' | 'conversation'>('main')
  const [deviceId, setDeviceId] = useState('')
  /** The build being started, until the host accepts it. */
  const [starting, setStarting] = useState<DeviceRunMode | null>(null)
  const [reinstalling, setReinstalling] = useState(false)
  const busy = !!starting || reinstalling
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = view.kind === 'loaded' ? view.state : undefined
  const devices = [...(state?.devices.filter((device) => device.deviceHostId === 'local') ?? []), ANDROID_DOWNLOAD_TARGET]
  const device = devices.find((candidate) => candidate.deviceId === deviceId)
  const checkoutPath = source === 'conversation' ? conversationCheckoutPath : projectPath
  const latest = state?.runs.find((run) => run.checkoutPath === checkoutPath && run.source === source)
  const normalizedDeviceId = runDeviceSelectionId(deviceId, latest)
  useEffect(() => setDeviceId(normalizedDeviceId), [normalizedDeviceId])
  const active = !!latest && isDeviceRunActive(latest)
  const output = state?.builds.find((build) => build.buildId === latest?.buildId)
  const api = app.connections.connection(hostId)?.api

  async function start(mode: DeviceRunMode) {
    if (!api || !checkoutPath || !device || busy) return
    setStarting(mode)
    setError(null)
    try {
      const request: DeviceRunStartRequest = { checkoutPath, deviceId: device.deviceId, deviceHostId: device.deviceHostId, mode, source, delivery: device.deviceId === 'android-download' ? 'download' : 'install' }
      if (sessionId) request.sessionId = sessionId
      await startDeviceRun(api, request, (question) => new Promise<boolean>((resolve) => {
        Alert.alert('Run this command?', question, [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Run', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) })
      }))
      await refresh()
    } catch (cause) { setError(deviceErrorText(cause)) }
    finally { setStarting(null) }
  }

  async function enableSupport() {
    if (!api) return
    try { await api.deviceConfigure({ enabled: true }); await refresh() }
    catch (cause) { setError(deviceErrorText(cause)) }
  }

  async function pair() {
    if (!api || !device || pairing) return
    setPairing(true)
    try { await api.devicePair(device); await refresh() }
    catch (cause) { setError(deviceErrorText(cause)) }
    finally { setPairing(false) }
  }

  async function stop() {
    if (!api || !latest) return
    try { await api.deviceRunCancel(latest.runId); await refresh() }
    catch (cause) { setError(deviceErrorText(cause)) }
  }

  async function reinstall() {
    if (!api || !output || !device || !state) return
    setReinstalling(true)
    try {
      const control = state.controls.find((entry) => entry.deviceHostId === device.deviceHostId && entry.deviceId === device.deviceId)
        ?? { deviceHostId: device.deviceHostId, deviceId: device.deviceId, lease: null, agentPaused: false }
      await installDeviceBuild(api, device, output, control, false)
      await refresh()
    } catch (cause) { setError(deviceErrorText(cause)) }
    finally { setReinstalling(false) }
  }

  async function download() {
    const connection = app.connections.connection(hostId)
    if (!connection || !output?.assetId) return
    try {
      const signed = await connection.api.assetCreateUrl(undefined, { assetId: output.assetId, name: buildDownloadName(output) })
      await Linking.openURL(new URL(signed.relativeUrl, `${connection.transport.serverUrl.replace(/\/+$/, '')}/`).toString())
      Alert.alert('Download opened', 'Install the APK on Android. Solus cannot confirm the phone installer result.')
    } catch (cause) { setError(deviceErrorText(cause)) }
  }

  return <ScrollView className="flex-1 bg-sheet" contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }} refreshControl={<RefreshControl refreshing={view.kind === 'loading'} onRefresh={refresh} />}>
    <HostStatusBanner hostId={hostId} />
    {view.kind === 'error' ? <ErrorBanner message={view.message} /> : null}
    <Text className="text-base font-t3-bold">Run app</Text>
    {state?.settings.enabled === false ? <ControlPill variant="primary" label="Enable device support" onPress={() => void enableSupport()} /> : null}
    <RunAppSelection projectOptions={projects.map((entry) => ({ id: entry.project.path, title: entry.project.folderName }))} projectPath={projectPath}
      source={source} conversationCheckoutPath={conversationCheckoutPath} devices={devices} device={device} active={active} pairing={pairing} onPair={() => void pair()} onCheck={() => void refresh()}
      onProject={(path) => { setProjectPath(path); setSource('main') }} onSource={(next) => { setSource(next); if (next === 'conversation') setProjectPath(route.params.projectPath ?? '') }} onDevice={setDeviceId} />
    <View className="gap-2">
      <RunAppActions device={device} active={active} busy={busy} starting={starting} canConnect={!!api} hasCheckout={!!checkoutPath} hasSupport={state?.settings.enabled === true}
        onTest={() => void start('dev')} onInstall={() => void start('device')} />
      {error ? <ErrorBanner message={error} /> : null}
    </View>
    {latest ? <RunAppOutput run={latest} device={device} hasOutput={!!output} canDownload={!!output?.assetId && latest.mode === 'device'} busy={busy}
      onStop={() => void stop()} onReinstall={() => void reinstall()} onDownload={() => void download()}
      onLog={() => navigation.push('BuildLog', { hostId, runId: latest.runId })} /> : null}
    <ControlPill variant="pill" label="Advanced configuration" disabled={!projectPath || active} onPress={() => navigation.push('BuildProfiles', { hostId, projectPath })} />
  </ScrollView>
}

interface RunAppOutputProps {
  run: DeviceRun
  device: DeviceSummary | undefined
  hasOutput: boolean
  canDownload: boolean
  busy: boolean
  onStop: () => void
  onReinstall: () => void
  onDownload: () => void
  onLog: () => void
}

function RunAppOutput({ run, device, hasOutput, canDownload, busy, onStop, onReinstall, onDownload, onLog }: RunAppOutputProps) {
  const active = isDeviceRunActive(run)
  const disabled = busy || !device
  const isDownload = device?.deviceId === 'android-download'
  const meta = [run.checkout, run.branch, run.deviceName].filter(Boolean).join(' · ')
  return <View className="gap-3 rounded-[20px] bg-grouped-card p-4" accessibilityLiveRegion="polite">
    <View className="flex-row items-center gap-3">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-bold" numberOfLines={1}>{runStageLabel(run)}</Text>
        {meta ? <Text className="text-sm text-foreground-muted" numberOfLines={1}>{meta}</Text> : null}
      </View>
      {active ? <ControlPill variant="pill" label="Stop" onPress={onStop} /> : null}
    </View>
    {run.error ? <ErrorBanner message={run.error} /> : null}
    <View className="flex-row flex-wrap gap-2">
      <ControlPill variant="pill" label="Log" onPress={onLog} />
      {hasOutput && !active && !isDownload ? <ControlPill variant="pill" label="Reinstall last build" disabled={disabled} onPress={onReinstall} /> : null}
      {canDownload ? <ControlPill variant="pill" label="Download APK" onPress={onDownload} /> : null}
    </View>
  </View>
}

interface RunAppSelectionProps {
  pairing: boolean
  onPair: () => void
  onCheck: () => void
  projectOptions: { id: string; title: string }[]
  projectPath: string
  source: 'main' | 'conversation'
  conversationCheckoutPath: string | undefined
  devices: DeviceSummary[]
  device: DeviceSummary | undefined
  active: boolean
  onProject: (path: string) => void
  onSource: (source: 'main' | 'conversation') => void
  onDevice: (deviceId: string) => void
}

function RunAppSelection({ projectOptions, projectPath, source, conversationCheckoutPath, devices, device, active, pairing, onPair, onCheck, onProject, onSource, onDevice }: RunAppSelectionProps) {
  const projectLabel = projectOptions.find((project) => project.id === projectPath)?.title ?? (projectPath || 'Choose project')
  return <>
    <View className="gap-2"><Text className="text-sm text-foreground-muted">Project</Text>
      <ControlPillMenu accessibilityLabel="Choose project" title="Choose project" actions={projectOptions} onPressAction={({ nativeEvent }) => { if (!active) onProject(nativeEvent.event) }}>
        <ControlPill variant="pill" label={projectLabel} disabled={active} />
      </ControlPillMenu>
    </View>
    <View className="gap-2"><Text className="text-sm text-foreground-muted">Device</Text>
      <ControlPillMenu accessibilityLabel="Choose device" title="Choose simulator or connected device" actions={devices.map((target) => ({ id: target.deviceId, title: `${target.name} · ${target.platform}` }))} onPressAction={({ nativeEvent }) => { if (!active) onDevice(nativeEvent.event) }}>
        <ControlPill variant="pill" label={device?.name ?? 'Choose device'} disabled={active} />
      </ControlPillMenu>
    </View>
    {conversationCheckoutPath ? <View className="gap-2"><Text className="text-sm text-foreground-muted">Code</Text>
      <View className="flex-row flex-wrap gap-2">
        <ControlPill variant={source === 'main' ? 'primary' : 'pill'} label="Main" disabled={active} onPress={() => onSource('main')} />
        <ControlPill variant={source === 'conversation' ? 'primary' : 'pill'} label="This conversation" disabled={active} onPress={() => onSource('conversation')} />
      </View>
    </View> : null}
    {device?.unavailableReason ? <View className="gap-2">
      <ErrorBanner message={pairing ? `Unlock ${device.name} and tap Trust.` : device.unavailableReason} />
      {device.needsPairing ? <ControlPill variant="pill" label={pairing ? 'Waiting for Trust...' : 'Pair device'} disabled={pairing || active} onPress={onPair} />
        : <ControlPill variant="pill" label="Check device again" onPress={onCheck} />}
    </View> : null}
  </>
}

interface RunAppActionsProps {
  device: DeviceSummary | undefined
  active: boolean
  busy: boolean
  starting: DeviceRunMode | null
  canConnect: boolean
  hasCheckout: boolean
  hasSupport: boolean
  onTest: () => void
  onInstall: () => void
}

function RunAppActions({ device, active, busy, starting, canConnect, hasCheckout, hasSupport, onTest, onInstall }: RunAppActionsProps) {
  const cannotStart = !hasSupport || !canConnect || !hasCheckout || !device || !!device.unavailableReason || active || busy
  const isDownload = device?.deviceId === 'android-download'
  return <View className="gap-2">
    <RunAppAction icon="bolt.circle" title="Dev build" detail={isDownload ? 'Connect the phone to this host to debug it.' : 'Debug with live reload from a dev server.'}
      isStarting={starting === 'dev'} disabled={cannotStart || isDownload} onPress={onTest} />
    <RunAppAction icon="arrow.down.circle" title={isDownload ? 'Build APK' : 'Device build'} detail={isDownload ? 'A release app to download and install on the phone.' : 'A release app that runs on its own.'}
      isStarting={starting === 'device'} disabled={cannotStart} onPress={onInstall} />
  </View>
}

function RunAppAction({ icon, title, detail, isStarting, disabled, onPress }: { icon: AppSymbolName; title: string; detail: string; isStarting: boolean; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${detail}`} accessibilityState={{ disabled, busy: isStarting }} disabled={disabled} onPress={onPress}
    className={connectCardClassName} style={{ borderWidth: StyleSheet.hairlineWidth, opacity: disabled && !isStarting ? 0.5 : 1 }}>
    <ConnectCardTile>
      {isStarting ? <ActivityIndicator size="small" /> : <SymbolView name={icon} size={15} tintColorClassName="accent-foreground-muted" type="monochrome" />}
    </ConnectCardTile>
    <View className="min-w-0 flex-1 gap-0.5">
      <Text className="text-[15px] font-t3-medium leading-snug text-foreground" numberOfLines={1}>{title}</Text>
      <Text className="text-[13px] text-foreground-muted" numberOfLines={2}>{detail}</Text>
    </View>
  </Pressable>
}
