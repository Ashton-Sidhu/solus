import { isProviderUpdateActive, type ProviderUpdateStatus } from '@solus/contracts/host-update-types'

/** The same host-owned facts on native mobile, desktop, and web. */
export function providerUpdateDetail(status: ProviderUpdateStatus): string {
  const parts: string[] = []
  const installation = status.installation
  if (installation) {
    parts.push(installation.method === 'native' && installation.managed ? 'Native · managed by Solus' : installation.method === 'absent' ? 'Not installed' : `${installation.method} · managed outside Solus`)
    if (installation.path) parts.push(installation.path)
    if (installation.method !== 'absent') parts.push(installation.automatic ? 'Automatic updates on' : 'Automatic updates off')
    parts.push(installation.source === 'mirror' ? 'Approved mirror' : installation.source === 'npm' ? 'Configured npm registry' : 'Vendor download')
    if (installation.remediation && status.check.kind === 'available') parts.push(installation.remediation)
  }
  const operation = providerOperationText(status)
  if (operation) parts.push(operation)
  if (status.check.kind === 'available' || status.check.kind === 'error') parts.push(`Last check: ${new Date(status.check.checkedAt).toLocaleString()}`)
  return parts.join('\n')
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
