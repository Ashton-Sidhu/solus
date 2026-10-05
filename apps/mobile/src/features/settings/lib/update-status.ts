import type { HostUpdateStatus } from '@solus/contracts/host-update-types'

/** What a host's last update check found, in one short line. */
export function updateStatusText(status: Pick<HostUpdateStatus, 'install' | 'check'>): string {
  if (status.install === 'cloud') return 'Updated by Solus Cloud'
  const { check } = status
  switch (check.kind) {
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return 'Up to date'
    case 'available': return `Version ${check.latestVersion} is available`
    case 'error': return check.latestVersion ? `Version ${check.latestVersion} is available` : 'Update check failed'
    case 'idle': return check.reason ?? 'Not checked yet'
  }
}
