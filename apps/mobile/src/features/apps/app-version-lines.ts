import { deployEventDetail, lastActivation, revisionStatsText, shortCommit, type AppChangeLogEntry, type AppDeployEvent } from '@solus/client-core/app-versions'
import type { AppVersionView } from '@solus/contracts/apps'
import { attributionLabel } from '@solus/contracts/user'
import type { RowLine } from '../webhooks/webhook-rows'
import { agoText, durationText } from './apps'

/**
 * The words of the Versions section on the phone (docs/plans/apps.md §9.2).
 * The history itself is `@solus/client-core/app-versions`, the one model the
 * desktop and the web draw too; this file only says it in rows.
 */

/** What one build holds: `4 operations · a UI · built in 1.2 s`. */
export function versionFactsText(version: Pick<AppVersionView, 'operationCount' | 'hasUi' | 'buildMs'>): string {
  const facts = [version.operationCount === 1 ? '1 operation' : `${version.operationCount} operations`, version.hasUi ? 'a UI' : 'no UI']
  if (version.buildMs !== null) facts.push(`built in ${durationText(version.buildMs)}`)
  return facts.join(' · ')
}

/** The lines under the live version: since when and by whom, its revision and build, and what it may use. */
export function liveLines(live: AppVersionView, now: number): RowLine[] {
  const since = lastActivation(live)
  const lines: RowLine[] = [
    { text: `Since ${agoText(since.at, now)} · ${attributionLabel(since.by)}` },
    { text: `Revision ${shortCommit(live.revision)} · ${versionFactsText(live)}` },
  ]
  if (live.permissionsNotice) lines.push({ text: live.permissionsNotice })
  return lines
}

/** The lines of one save: its revision, when, how much it changed, and the versions built from it. */
export function changeLogLines(entry: AppChangeLogEntry, now: number): RowLine[] {
  const lines: RowLine[] = [{ text: `${shortCommit(entry.revision.commit)} · Saved ${agoText(entry.revision.savedAt, now)} · ${revisionStatsText(entry.revision.stats)}` }]
  if (entry.versions.length > 0) {
    const built = entry.versions.map((version) => `v${version.number}${version.state === 'active' ? ' (live)' : version.state === 'failed' ? ' (failed)' : version.state === 'building' ? ' (building)' : ''}`)
    lines.push({ text: `Built as ${built.join(', ')}` })
  }
  return lines
}

/**
 * The lines of one deploy, rollback, roll forward, or failed build: what it
 * replaced, who, when, and from which save. The line of the activation that
 * put the live version in place says `Live` first.
 */
export function deployEventLines(event: AppDeployEvent, now: number): RowLine[] {
  const detail = deployEventDetail(event)
  return [
    { text: event.isLive ? `Live · ${detail}` : detail, tone: event.kind === 'failed' ? 'danger' : 'muted' },
    { text: `${attributionLabel(event.by)} · ${agoText(event.at, now)}` },
    { text: `${shortCommit(event.version.revision)} ${event.version.message || 'No message'}` },
  ]
}
