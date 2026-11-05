import type { CloudDeviceHostConfig } from '@solus/contracts/device-types'

export function newCloudDeviceHost(id: string): CloudDeviceHostConfig {
  return { kind: 'simlock', id, label: 'Simlock', gatewayUrl: '', agentToken: '', maxLeases: 2, maxLeaseMinutes: 60 }
}
export function cloudDeviceHostLimits(host: CloudDeviceHostConfig): string {
  return `Up to ${host.maxLeases} devices, released after ${host.maxLeaseMinutes} min.`
}
