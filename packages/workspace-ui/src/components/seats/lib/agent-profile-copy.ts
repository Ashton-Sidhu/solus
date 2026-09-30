import type { AgentProfileStatus } from '@solus/contracts/agent-profile'
import { relativeTime } from '../../../lib/relative-time'

/** One line under "Instructions and skills": what is on this host, and where it came from. */
export function agentProfileDescription(
  status: AgentProfileStatus | undefined,
  error: string | undefined,
  canCopy: boolean,
): string {
  if (error) return error
  const source = canCopy
    ? 'Your CLAUDE.md, AGENTS.md, skills, subagents, and commands from this computer.'
    : 'Your CLAUDE.md, AGENTS.md, skills, subagents, and commands, copied by Solus on your computer.'
  if (!status || status.syncedAt === null) return `${source} Not on this host yet.`
  const files = status.fileCount === 1 ? '1 file' : `${status.fileCount} files`
  const keptOnHost = status.skipped.filter((skip) => skip.reason === 'kept-on-host').length
  const notSent = status.skipped.length - keptOnHost
  const kept = keptOnHost > 0 ? ` ${keptOnHost} kept as this host already had them.` : ''
  const skipped = notSent > 0 ? ` ${notSent} left out: over the size limit or unreadable.` : ''
  return `${source} Copied ${relativeTime(status.syncedAt)}, ${files}.${kept}${skipped}`
}
