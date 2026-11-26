import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { SetupAgent } from '@solus/contracts/types'

const SETUP_AGENT_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'Google Antigravity',
} as const satisfies Record<SetupAgent, string>

/** The name a person reads for an agent's software on a host. */
export function setupAgentLabel(agent: SetupAgent): string {
  return SETUP_AGENT_LABELS[agent]
}

/** Names every failed update check and the reason reported by the host. */
export function updateCheckFailureText(status: Pick<HostUpdateStatus, 'check'> & Partial<Pick<HostUpdateStatus, 'providers'>>): string | null {
  const failures: string[] = []
  if (status.check.kind === 'error') failures.push(`Solus: ${status.check.message}`)
  for (const provider of status.providers ?? []) {
    if (provider.check.kind === 'error') failures.push(`${setupAgentLabel(provider.agent)}: ${provider.check.message}`)
  }
  return failures.length ? failures.join('\n') : null
}
