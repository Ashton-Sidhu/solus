import type { HostUpdateItem } from './host-updates.store.svelte'

/** One update as the user reads it: what, which release, and on which host. */
export interface UpdateLine { target: HostUpdateItem['target']; version: string; host: string }
export type UpdateOutcome = { phase: 'running'; detail: string | null } | { phase: 'succeeded' } | { phase: 'failed'; error: string }
interface ToastText { message: string; description?: string }

export function updateTargetLabel(target: HostUpdateItem['target']): string {
  return target === 'solus' ? 'Solus' : target === 'claude' ? 'Claude Code' : 'Codex'
}

function lineText(line: UpdateLine): string { return `${updateTargetLabel(line.target)} ${line.version} on ${line.host}` }

/** The one notice for every pending update, however many hosts they are on. */
export function updateNoticeText(lines: UpdateLine[]): ToastText {
  if (lines.length === 1) return { message: `${lineText(lines[0])} is available` }
  return { message: `${lines.length} updates available`, description: lines.map(lineText).join(' · ') }
}

export function updateProgressText(entries: Array<UpdateLine & { outcome: UpdateOutcome }>): ToastText {
  const done = entries.filter((entry) => entry.outcome.phase !== 'running').length
  const details = entries.flatMap((entry) => entry.outcome.phase === 'running' && entry.outcome.detail ? [entry.outcome.detail] : [])
  const message = entries.length === 1 ? `Updating ${updateTargetLabel(entries[0].target)} on ${entries[0].host}…` : `Updating ${done} of ${entries.length}…`
  return details.length ? { message, description: details.join(' · ') } : { message }
}

/** The one result for an "Update all": every failure is named, success is counted. */
export function updateSummaryText(entries: Array<UpdateLine & { outcome: UpdateOutcome }>): ToastText & { hasFailed: boolean } {
  const failures = entries.flatMap((entry) => entry.outcome.phase === 'failed' ? [`${updateTargetLabel(entry.target)} on ${entry.host}: ${entry.outcome.error}`] : [])
  if (!failures.length) {
    return { hasFailed: false, message: entries.length === 1 ? `${updateTargetLabel(entries[0].target)} on ${entries[0].host} updated to ${entries[0].version}` : `${entries.length} updates installed` }
  }
  const message = failures.length === entries.length
    ? entries.length === 1 ? `Could not update ${updateTargetLabel(entries[0].target)} on ${entries[0].host}` : 'Updates failed'
    : `${failures.length} of ${entries.length} updates failed`
  return { hasFailed: true, message, description: failures.join('\n') }
}
