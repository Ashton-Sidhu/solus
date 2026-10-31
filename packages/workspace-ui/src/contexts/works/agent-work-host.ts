import { solusApiId } from '@solus/contracts/uplink'

/**
 * The server that holds a work an agent wrote. An organization session on an
 * attached machine saves through the organization's Solus API, so its works
 * are there, not on the machine that ran the agent. Any other work is on the
 * session's host. An older host does not say, so the session's host is the guess.
 */
export function agentWorkHost(organizationId: string | null | undefined, sessionHost: string | undefined): string | undefined {
  return organizationId ? solusApiId(organizationId) : sessionHost
}
