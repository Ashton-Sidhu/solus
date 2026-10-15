import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import { updateCheckFailureText } from '@solus/client-core/host-update-text'

/** What a host's last update check found, in one short line. */
export function updateStatusText(status: Pick<HostUpdateStatus, 'install' | 'check'> & Partial<Pick<HostUpdateStatus, 'providers'>>): string {
  if (status.install === 'cloud') return 'Updated by Solus Cloud'
  const failure = updateCheckFailureText(status)
  if (failure) return failure
  const { check } = status
  switch (check.kind) {
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return 'Up to date'
    case 'available': return `Version ${check.latestVersion} is available`
    case 'error': return `Solus: ${check.message}`
    case 'idle': return check.reason ?? 'Not checked yet'
  }
}
