import type { DevicePreview, DeviceState, DeviceSummary } from '@solus/contracts/device-types'
import { SettingsSection } from '../settings/components/SettingsSection'
import { SettingsActionRow } from '../settings/components/SettingsActionRow'
import { SettingsNote } from '../settings/components/SettingsNote'
export function DeviceCatalog(props: { state: DeviceState | undefined; previews: DevicePreview[]; hasSession: boolean; busy: boolean; onSettings: () => void; onRefresh: () => void; onOpen: (device: DeviceSummary) => void }) {
  if (!props.state) return <SettingsNote>Loading devices…</SettingsNote>
  if (!props.state.settings.enabled) return <SettingsActionRow icon="gearshape" label="Set up devices" onPress={props.onSettings} />
  const state = props.state
  const available = state.devices.filter((device) => !device.physical && !props.previews.some((item) => item.deviceHostId === device.deviceHostId && item.deviceId === device.deviceId))
  return <>
    {!props.hasSession ? <SettingsNote>Open Devices from a session’s Environment menu to start another device. Devices already open on this host appear here.</SettingsNote> : null}
    <SettingsSection title="Available devices">
      {available.length ? available.map((device) => <SettingsActionRow key={`${device.deviceHostId}/${device.deviceId}`} icon="desktopcomputer" label={`${device.name} · ${state.hosts.find((item) => item.deviceHostId === device.deviceHostId)?.label ?? device.deviceHostId}`} disabled={props.busy || !props.hasSession} onPress={() => props.onOpen(device)} />) : <SettingsNote>No devices are available. Check the source settings or refresh the list.</SettingsNote>}
      <SettingsActionRow icon="arrow.clockwise" label="Refresh devices" disabled={props.busy} onPress={props.onRefresh} />
    </SettingsSection>
    {state.hostStatuses.filter((status) => status.status === 'failed').map((status) => <SettingsNote key={status.deviceHostId}>{`${state.hosts.find((host) => host.deviceHostId === status.deviceHostId)?.label ?? status.deviceHostId}: ${status.detail ?? 'Connection failed.'}`}</SettingsNote>)}
  </>
}
