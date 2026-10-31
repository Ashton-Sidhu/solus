import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { CloudDeviceHostConfig } from '@solus/contracts/device-types'
import { newCloudDeviceHost, cloudDeviceHostLimits } from '@solus/client-core/device-host-draft'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { AppText as Text } from '../../components/AppText'
import { ScreenScrollView } from '../../components/ScreenScrollView'
import { SettingsScreen } from '../settings/components/SettingsScreen'
import { SettingsSection } from '../settings/components/SettingsSection'
import { SettingsSwitchRow } from '../settings/components/SettingsSwitchRow'
import { SettingsActionRow } from '../settings/components/SettingsActionRow'
import { SettingsNote } from '../settings/components/SettingsNote'
import { CloudDeviceHostEditor } from './CloudDeviceHostEditor'

export function DeviceSettingsScreen({ route, navigation }: ScreenProps<'DeviceSettings'>) {
  const { hostId } = route.params
  const app = useApp()
  const state = useListened(app.devices.changes, () => app.devices.stateOf(hostId))
  const error = useListened(app.devices.changes, () => app.devices.errorOf(hostId))
  const [draft, setDraft] = useState<CloudDeviceHostConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const isAdmin = useListened(app.connections.changes, () => app.connections.may(hostId, 'host.admin'))
  useFocusEffect(useCallback(() => { void app.devices.load(hostId) }, [app, hostId]))
  async function run(work: () => Promise<void>) {
    setBusy(true)
    try { await work() } catch (cause) { Alert.alert('Device settings', cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return <SettingsScreen title="Devices"><ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 p-5 pb-12">
    {error ? <Text accessibilityRole="alert" className="text-base text-danger-foreground">{error}</Text> : null}
    {!state ? <SettingsNote>{error ? 'Reconnect the host and try again.' : 'Loading devices…'}</SettingsNote> : <>
      <SettingsSection title="Devices">
        <SettingsSwitchRow icon="desktopcomputer" label="Use devices" value={state.settings.enabled} disabled={busy || !isAdmin} onValueChange={(enabled) => void run(() => app.devices.configure(hostId, { enabled }))} />
        <SettingsSwitchRow icon="desktopcomputer" label="Agent access" value={state.settings.agentAccessEnabled} disabled={busy || !isAdmin || !state.settings.enabled} onValueChange={(agentAccessEnabled) => void run(() => app.devices.configure(hostId, { agentAccessEnabled }))} />
        <SettingsSwitchRow icon="eye" label="Show devices agents open" value={state.settings.autoShowAgentDevices} disabled={busy || !isAdmin} onValueChange={(autoShowAgentDevices) => void run(() => app.devices.configure(hostId, { autoShowAgentDevices }))} />
        <SettingsActionRow icon="desktopcomputer" label="Open devices" onPress={() => navigation.navigate('Devices', { hostId })} />
      </SettingsSection>
      {state.hosts.filter((host) => host.config).map((host) => <SettingsSection key={host.deviceHostId} title={host.label} footer={host.config ? cloudDeviceHostLimits(host.config) : undefined}>
        <SettingsActionRow icon="pencil" label={`Edit ${host.kind === 'eas' ? 'EAS Simulator' : 'Simlock pool'}`} disabled={busy || !isAdmin || !!draft} onPress={() => setDraft(host.config ?? null)} />
        <SettingsActionRow icon="trash" label="Remove source" tone="danger" disabled={busy || !isAdmin} onPress={() => Alert.alert('Remove device source?', 'This stops its EAS sessions or returns its Simlock leases.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => void run(() => app.devices.remove(hostId, host.deviceHostId)) }])} />
      </SettingsSection>)}
      {draft ? <CloudDeviceHostEditor key={draft.id} hostId={hostId} config={draft} close={() => setDraft(null)} /> : isAdmin ? <SettingsSection title="Cloud devices">
        <SettingsActionRow icon="plus" label="Add EAS Simulator" disabled={busy} onPress={() => setDraft(newCloudDeviceHost('eas', `eas-${app.platform.uuid()}`))} />
        <SettingsActionRow icon="plus" label="Add Simlock pool" disabled={busy} onPress={() => setDraft(newCloudDeviceHost('simlock', `simlock-${app.platform.uuid()}`))} />
      </SettingsSection> : null}
      <SettingsNote>EAS Simulator sessions use your Expo account and are billed by Expo. Simlock uses the gateway and workers you operate.</SettingsNote>
    </>}
  </ScreenScrollView></SettingsScreen>
}
