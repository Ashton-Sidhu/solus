import type { HostUpdateStatus, ProviderUpdateStatus, UpdateCheckState } from '@solus/contracts/host-update-types'
import type { ProviderRow } from '../../servers/lib/host-onboarding'
import type { SetupAgent } from '@solus/contracts/types'
import { formatCheckedAt } from '../../settings/lib/update-status-text'
import { isProviderUpdateActive } from '@solus/contracts/host-update-types'
import { providerUpdateDetail } from '@solus/client-core/provider-update-text'
import { setupAgentLabel } from '@solus/client-core/host-update-text'

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
  if (status.install === 'cloud') return `Solus ${status.currentVersion} · Kept up to date by Solus cloud.`
  return `Solus ${status.currentVersion} · ${checkStatusLine(status.check)}`
}

export function providerUpdateRows(rows: ProviderRow[], updates: ProviderUpdateStatus[], update: (agent: SetupAgent) => void, mayUpdate = true): ProviderRow[] {
  for (const row of rows) {
    const status = updates.find((item) => item.agent === row.id)
    if (!status) continue
    if (isProviderUpdateActive(status.update)) {
      row.state = 'busy'
      row.detail = providerUpdateDetail(status)
      row.disabled = true
      continue
    }
    if (row.state === 'busy') {
      if (status.installedVersion && row.detail === 'Installing…') row.detail = 'Updating…'
      continue
    }
    // Update checks do not establish authentication. Keep the host's sign-in
    // status visible when adding version information, including after an update.
    // An available release is named by its Update button, not repeated here.
    // Without that button (Solus cannot update this installation), the row names it.
    const canUpdate = status.installation?.canUpdate !== false
    if (status.installedVersion) row.detail += status.check.kind === 'available' && canUpdate ? ` · ${status.installedVersion}` : ` · ${status.installedVersion} · ${checkStatusLine(status.check)}`
    else if (status.check.kind === 'error') row.detail += ` · version unknown · ${status.check.message}`
    const detail = providerUpdateDetail(status)
    if (detail) row.detail += `\n${detail}`
    if (status.check.kind === 'available' && canUpdate) row.update = { label: `${status.update?.phase === 'failed' ? 'Retry update to' : 'Update to'} ${status.check.latestVersion}`, disabled: !mayUpdate, run: () => { if (mayUpdate) update(status.agent) } }
  }
  return rows
}

/** "A", "A and B", "A, B, and C". */
function listOf(names: string[]): string {
  return names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
}

export function providerSummary(status: HostUpdateStatus | undefined): string {
  if (!status) return 'Provider update status is not available'
  const count = status.providers.filter((p) => p.check.kind === 'available').length
  if (count) return `${count} provider update${count === 1 ? '' : 's'} on this computer`
  const installed = status.providers.filter((p) => p.installedVersion)
  if (installed.length && installed.every((p) => p.check.kind === 'up-to-date')) return `${listOf(installed.map((p) => setupAgentLabel(p.agent)))} ${installed.length === 1 ? 'is' : 'are'} up to date`
  return status.providers.some((p) => p.check.kind === 'checking') ? 'Checking provider updates…' : 'Open providers to see update status'
}

/** One agent installed on a host, and the other installation it can move to. */
export interface AgentInstallationRow {
  agent: SetupAgent
  label: string
  description: string
  /** Null when there is no other installation to move to. */
  switchTo: 'native' | 'existing' | null
}

/** Every agent installed on the host, with where it comes from. An agent that
 *  is not installed has no row: the coding providers card adds it. */
export function agentInstallationRows(providers: ProviderUpdateStatus[]): AgentInstallationRow[] {
  return providers.flatMap(({ agent, installation }): AgentInstallationRow[] => {
    if (!installation || installation.method === 'absent') return []
    const label = setupAgentLabel(agent)
    if (!installation.managed) {
      return [{ agent, label, switchTo: 'native', description: 'Installed on this host’s PATH. Use a verified native package managed by Solus, and keep the existing installation so you can return to it.' }]
    }
    if (installation.existingPath) {
      return [{ agent, label, switchTo: 'existing', description: 'Native package managed by Solus. Return to the installation on this host’s PATH. Active turns continue with their current version.' }]
    }
    return [{ agent, label, switchTo: null, description: 'Native package managed by Solus.' }]
  })
}
