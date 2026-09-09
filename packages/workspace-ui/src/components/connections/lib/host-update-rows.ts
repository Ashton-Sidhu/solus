import type { HostUpdateStatus, ProviderUpdateStatus, UpdateCheckState } from '@solus/contracts/host-update-types'
import type { ProviderRow } from '../../servers/lib/host-onboarding'
import type { SetupAgent } from '@solus/contracts/types'
import { formatCheckedAt } from '../../settings/lib/update-status-text'

export function checkStatusLine(check: UpdateCheckState): string {
  switch (check.kind) {
    case 'idle': return check.reason ?? 'Not checked yet'
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return `Up to date · checked ${formatCheckedAt(check.checkedAt)}`
    case 'available': return `${check.latestVersion} available`
    case 'error': return `${check.message}${check.latestVersion ? ` · last known release ${check.latestVersion}` : ''}`
  }
}

export function hostUpdateLine(status: HostUpdateStatus | undefined): string {
  if (!status) return 'Update status not reported by this host'
  if (status.install === 'desktop') return `Solus ${status.currentVersion} · Updates with the Solus app.`
  return `Solus ${status.currentVersion} · ${checkStatusLine(status.check)}`
}

export function providerUpdateRows(rows: ProviderRow[], updates: ProviderUpdateStatus[], update: (agent: SetupAgent) => void): ProviderRow[] {
  for (const row of rows) {
    const status = updates.find((item) => item.agent === row.id)
    if (!status) continue
    if (row.state === 'busy') {
      if (status.installedVersion && row.detail === 'Installing…') row.detail = 'Updating…'
      continue
    }
    // Update checks do not establish authentication. Keep the host's sign-in
    // status visible when adding version information, including after an update.
    if (status.installedVersion) row.detail += ` · ${status.installedVersion} · ${checkStatusLine(status.check)}`
    else if (status.check.kind === 'error') row.detail += ` · version unknown · ${status.check.message}`
    if (status.check.kind === 'available') row.secondary = { label: 'Update', run: () => update(status.agent) }
  }
  return rows
}

export function providerSummary(status: HostUpdateStatus | undefined): string {
  if (!status) return 'Provider update status is not available'
  const count = status.providers.filter((p) => p.check.kind === 'available').length
  if (count) return `${count} provider update${count === 1 ? '' : 's'} on this computer`
  const installed = status.providers.filter((p) => p.installedVersion)
  if (installed.length && installed.every((p) => p.check.kind === 'up-to-date')) return `${installed.map((p) => p.agent === 'claude' ? 'Claude Code' : 'Codex').join(' and ')} ${installed.length === 1 ? 'is' : 'are'} up to date`
  return status.providers.some((p) => p.check.kind === 'checking') ? 'Checking provider updates…' : 'Open providers to see update status'
}
