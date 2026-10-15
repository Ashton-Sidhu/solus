import type { HostUpdateStatus } from '@solus/contracts/host-update-types'

/** Names every failed update check and the reason reported by the host. */
export function updateCheckFailureText(status: Pick<HostUpdateStatus, 'check'> & Partial<Pick<HostUpdateStatus, 'providers'>>): string | null {
  const failures: string[] = []
  if (status.check.kind === 'error') failures.push(`Solus: ${status.check.message}`)
  for (const provider of status.providers ?? []) {
    if (provider.check.kind === 'error') failures.push(`${provider.agent === 'claude' ? 'Claude Code' : 'Codex'}: ${provider.check.message}`)
  }
  return failures.length ? failures.join('\n') : null
}
