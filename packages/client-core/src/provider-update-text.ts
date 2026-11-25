import { isProviderUpdateActive, type ProviderUpdateStatus } from '@solus/contracts/host-update-types'

/**
 * The lines a provider row adds below its version: only what the person must
 * know or do now. How the agent was installed stays out of a working row.
 */
export function providerUpdateDetail(status: ProviderUpdateStatus): string {
  const operation = providerOperationText(status)
  if (operation) return operation
  const remediation = status.installation?.remediation
  return status.check.kind === 'available' && remediation ? remediation : ''
}

function providerOperationText(status: ProviderUpdateStatus): string | null {
  const operation = status.update
  if (isProviderUpdateActive(operation)) return operation?.phase === 'downloading' ? 'Downloading update…' : 'Verifying update…'
  if (operation?.phase === 'failed') return operation.message ?? 'Update failed'
  if (operation?.phase === 'succeeded' && status.installation?.managed) return operation.message ?? 'Update complete'
  return null
}

export function providerCheckText(status: ProviderUpdateStatus): string {
  switch (status.check.kind) {
    case 'idle': return status.check.reason ?? 'Not checked yet'
    case 'checking': return 'Checking for updates…'
    case 'available': return `${status.check.latestVersion} available`
    case 'up-to-date': return `Up to date · checked ${new Date(status.check.checkedAt).toLocaleString()}`
    case 'error': return `Cannot check for updates: ${status.check.message}${status.check.latestVersion ? ` Last known release: ${status.check.latestVersion}.` : ''}`
  }
}
