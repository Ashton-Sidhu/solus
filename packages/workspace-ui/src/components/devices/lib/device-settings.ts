import type { DeviceHostStatus, DeviceToolVersion } from '@solus/contracts/device-types'

/** The one version a tool chip shows: the running one, else the required one
 *  when installed, else the newest installed. Null when nothing is installed. */
export function shownToolVersion(tool: DeviceToolVersion): string | null {
  if (tool.runningVersion) return tool.runningVersion
  if (tool.installedVersions.includes(tool.requiredVersion)) return tool.requiredVersion
  return tool.installedVersions.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null
}

/** What a device host is doing now, while it is busy; null when it is not. */
export function hostProgressLabel(status: DeviceHostStatus | undefined): string | null {
  if (status === 'installing') return 'Installing device support…'
  if (status === 'starting') return 'Connecting…'
  return null
}
