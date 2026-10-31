import type { CloudDeviceHostConfig } from '@solus/contracts/device-types'

export function newCloudDeviceHost(kind: 'eas' | 'simlock', id: string): CloudDeviceHostConfig {
  return kind === 'eas'
    ? { kind, id, label: 'EAS Simulator', appId: '', accessToken: '', maxSessionMinutes: 30, idleMinutes: 10, maxConcurrentSessions: 2 }
    : { kind, id, label: 'Simlock', gatewayUrl: '', agentToken: '', maxLeases: 2, maxLeaseMinutes: 60 }
}
export function cloudDeviceHostLimits(host: CloudDeviceHostConfig): string {
  return host.kind === 'eas'
    ? `Up to ${host.maxConcurrentSessions} sessions, ${host.maxSessionMinutes} min each, ${host.idleMinutes} idle min.`
    : `Up to ${host.maxLeases} devices, released after ${host.maxLeaseMinutes} min.`
}
