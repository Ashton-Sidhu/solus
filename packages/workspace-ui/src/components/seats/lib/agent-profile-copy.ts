import type { AgentProfileStatus } from '@solus/contracts/agent-profile'
import type { UplinkStatus } from '@solus/contracts/uplink'
import { relativeTime } from '../../../lib/relative-time'

/** `3 files, 2 skills, 1 MCP server` for what a host holds; the parts that are zero are left out. */
export function agentProfileCounts(counts: AgentProfileStatus['counts']): string {
  const parts = [
    counts.files > 0 ? `${counts.files} ${counts.files === 1 ? 'file' : 'files'}` : null,
    counts.skills > 0 ? `${counts.skills} ${counts.skills === 1 ? 'skill' : 'skills'}` : null,
    counts.integrations > 0 ? `${counts.integrations} ${counts.integrations === 1 ? 'MCP server' : 'MCP servers'}` : null,
  ].filter((part) => part !== null)
  return parts.length ? parts.join(', ') : 'nothing'
}

/** One line under a host's row: what is on this host, and where it came from. */
export function agentProfileDescription(
  status: AgentProfileStatus | undefined,
  error: string | undefined,
  canCopy: boolean,
): string {
  if (error) return error
  const source = canCopy
    ? 'Your skills, subagents, commands, prompts, and MCP servers from this computer or your account.'
    : 'Your skills, subagents, commands, prompts, and MCP servers, from your account or copied by Solus on your computer.'
  if (!status || status.syncedAt === null) return `${source} Not on this host yet.`
  const from = status.source === 'account' ? 'from your account' : 'from your computer'
  const keptOnHost = status.skipped.filter((skip) => skip.reason === 'kept-on-host').length
  const failed = status.skipped.filter((skip) => skip.reason === 'install-failed').length
  const notSent = status.skipped.length - keptOnHost - failed
  const kept = keptOnHost > 0 ? ` ${keptOnHost} kept as this host already had them.` : ''
  const installs = failed > 0 ? ` ${failed} ${failed === 1 ? 'skill' : 'skills'} could not be installed.` : ''
  const skipped = notSent > 0 ? ` ${notSent} left out: over the size limit or unreadable.` : ''
  return `${source} Copied ${from} ${relativeTime(status.syncedAt)}: ${agentProfileCounts(status.counts)}.${kept}${installs}${skipped}`
}

/** The host's account link, in a few words, ahead of what it holds: changed on the host's Access page. */
export function hostLinkLabel(uplink: UplinkStatus | undefined): string {
  if (!uplink) return 'Checking the account link…'
  if (!uplink.registration.registered) return 'Not registered to your account.'
  return uplink.link.linked ? 'Registered to your account, reachable from the internet.' : 'Registered to your account.'
}
