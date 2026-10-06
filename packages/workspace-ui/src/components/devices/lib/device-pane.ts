import type {
  DeviceControlState,
  DeviceHostStatusEntry,
  DevicePreview,
  DeviceState,
  DeviceSummary,
} from '@solus/contracts/device-types'

/** Pure derivations for the Devices pane. Markup stays in the `.svelte` files. */

export type DeviceLiveState = 'live' | 'booting' | 'stopped' | 'offline'

export function deviceLiveState(device: DeviceSummary | undefined, booting: boolean, hostStatus: DeviceHostStatusEntry | undefined): DeviceLiveState {
  if (!device || hostStatus?.status === 'failed' || hostStatus?.status === 'disabled') return 'offline'
  if (booting) return 'booting'
  return device.booted ? 'live' : 'stopped'
}

export function liveStateLabel(state: DeviceLiveState): string {
  return { live: 'Live', booting: 'Booting…', stopped: 'Stopped', offline: 'Offline' }[state]
}

/** The selected preview: the remembered one if it still exists, else the newest. */
export function selectedPreview(previews: DevicePreview[], remembered: string | null): DevicePreview | null {
  return previews.find((preview) => preview.devicePreviewId === remembered) ?? previews.at(-1) ?? null
}

/** Open previews grouped under the device host that runs them, in the order they were opened, like browser pages under their branch. */
export function previewGroups(state: DeviceState | undefined, previews: DevicePreview[]): { deviceHostId: string; label: string; previews: DevicePreview[] }[] {
  const groups = new Map<string, { deviceHostId: string; label: string; previews: DevicePreview[] }>()
  for (const preview of previews) {
    let group = groups.get(preview.deviceHostId)
    if (!group) {
      const label = state?.hosts.find((host) => host.deviceHostId === preview.deviceHostId)?.label ?? preview.deviceHostId
      group = { deviceHostId: preview.deviceHostId, label, previews: [] }
      groups.set(preview.deviceHostId, group)
    }
    group.previews.push(preview)
  }
  return [...groups.values()]
}

/** Who controls the device, in one short phrase. */
export function controlLabel(control: DeviceControlState, holdsControl: boolean): string {
  if (holdsControl) return 'You have control'
  if (control.lease) return `${control.lease.holder.label} has control`
  if (control.agentPaused) return 'Agent actions paused'
  return 'Nobody has control'
}

/** Devices that can be added to a session: simulators and emulators not already open there, grouped by host. Connected phones take builds but have no preview. */
export function addableDevices(state: DeviceState | undefined, sessionId: string): { deviceHostId: string; label: string; devices: DeviceSummary[] }[] {
  if (!state) return []
  const open = new Set(state.previews.filter((preview) => preview.sessionId === sessionId).map((preview) => `${preview.deviceHostId}\u0000${preview.deviceId}`))
  return state.hosts.map((host) => ({
    deviceHostId: host.deviceHostId,
    label: host.label,
    devices: state.devices
      .filter((device) => device.deviceHostId === host.deviceHostId && !device.physical && !open.has(`${device.deviceHostId}\u0000${device.deviceId}`))
      .sort((a, b) => Number(b.booted) - Number(a.booted) || a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name)),
  })).filter((group) => group.devices.length > 0)
}

/** A platform that cannot run on any host, with the first reason given. */
export function unavailablePlatformReasons(state: DeviceState | undefined): string[] {
  if (!state) return []
  const reasons: string[] = []
  for (const platform of ['ios', 'android'] as const) {
    const entries = state.hosts.flatMap((host) => host.platforms.filter((entry) => entry.platform === platform))
    if (entries.length > 0 && entries.every((entry) => !entry.available)) {
      reasons.push(`${platform === 'ios' ? 'iOS' : 'Android'}: ${entries[0]?.reason ?? 'unavailable'}`)
    }
  }
  return reasons
}

/** A file name for a screenshot download. */
export function screenshotFileName(device: DeviceSummary, capturedAt: number): string {
  const stamp = new Date(capturedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${device.name.replace(/[^a-zA-Z0-9-]+/g, '-')}-${stamp}.png`
}
