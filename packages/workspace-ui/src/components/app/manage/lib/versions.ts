import type { AppDeployPreflight, AppNameChanges, AppVersionView } from '@solus/contracts/apps'
import { lastActivation, type AppChangeLogEntry } from '@solus/client-core/app-versions'
import { attributionLabel } from '@solus/contracts/user'
import { appTime } from '../../lib/app-view'
import { formatDuration } from '../../../insights/lib/format'

/** What one build holds: `4 operations · a UI · built in 977ms`. */
export function versionFactsText(version: Pick<AppVersionView, 'operationCount' | 'hasUi' | 'buildMs'>): string {
  const facts = [version.operationCount === 1 ? '1 operation' : `${version.operationCount} operations`, version.hasUi ? 'a UI' : 'no UI']
  if (version.buildMs !== null) facts.push(`built in ${formatDuration(version.buildMs)}`)
  return facts.join(' · ')
}

// ─── The history line ───

/** The mark of a save on the history line: not deployed, live, a failed build, or an earlier version. */
export type HistoryMark = 'ahead' | 'live' | 'failed' | 'behind'

export function historyMark(entry: Pick<AppChangeLogEntry, 'position' | 'versions'>): HistoryMark {
  if (entry.position === 'live') return 'live'
  if (entry.versions.length > 0 && entry.versions.every((version) => version.state === 'failed')) return 'failed'
  return entry.position
}

/** The line under a save on the history line: "Saved 20 min ago · not deployed", "Version 14 · 2 hr ago by Ann", "Build failed · …". */
export function historyMeta(entry: Pick<AppChangeLogEntry, 'position' | 'versions' | 'revision'>, nowMs: number): string {
  const mark = historyMark(entry)
  const newest = entry.versions[0] ?? null
  if (mark === 'failed') return `Build failed${newest?.error ? ` · ${newest.error.split('\n')[0]}` : ''}`
  if (!newest || mark === 'ahead') return `Saved ${appTime(entry.revision.savedAt, nowMs)} · not deployed`
  const since = mark === 'live' && newest.activations.length > 0 ? lastActivation(newest) : { at: newest.createdAt, by: newest.createdBy }
  return `Version ${newest.number} · ${appTime(since.at, nowMs)} by ${attributionLabel(since.by)}`
}

// ─── This deploy ───

/** One line of "This deploy": an addition, a removal, or a thing that needs the owner. */
export interface PreflightLine {
  sign: '+' | '−' | '!'
  text: string
  /** A secret the line names: "Set it" opens the Secrets section. */
  secret?: string
}

const CHANGE_WORDS: { key: Exclude<keyof AppDeployPreflight, 'commit' | 'against' | 'buildError' | 'secretsMissing'>; added: string; removed: string }[] = [
  { key: 'network', added: 'May reach', removed: 'No longer reaches' },
  { key: 'readPaths', added: 'May read', removed: 'No longer reads' },
  { key: 'writePaths', added: 'May write', removed: 'No longer writes' },
  { key: 'models', added: 'Adds the model setting', removed: 'Removes the model setting' },
  { key: 'integrations', added: 'Uses the integration', removed: 'No longer uses the integration' },
  { key: 'workflows', added: 'Adds the workflow', removed: 'Removes the workflow' },
  { key: 'schedules', added: 'Adds the schedule', removed: 'Removes the schedule' },
  { key: 'webhooks', added: 'Adds the webhook', removed: 'Removes the webhook' },
  { key: 'signals', added: 'Adds the signal', removed: 'Removes the signal' },
  { key: 'operations', added: 'Adds the operation', removed: 'Removes the operation' },
]

function changeLines(changes: AppNameChanges, added: string, removed: string): PreflightLine[] {
  return [...changes.added.map((name): PreflightLine => ({ sign: '+', text: `${added} ${name}` })), ...changes.removed.map((name): PreflightLine => ({ sign: '−', text: `${removed} ${name}` }))]
}

/** What a deploy of the revision changes, as lines: what it may now use and declares first, then the secrets it needs. */
export function preflightLines(preflight: AppDeployPreflight): PreflightLine[] {
  if (preflight.buildError) return [{ sign: '!', text: `The build fails: ${preflight.buildError.replace(/^The build failed: /, '')}` }]
  const lines = CHANGE_WORDS.flatMap(({ key, added, removed }) => changeLines(preflight[key], added, removed))
  for (const secret of preflight.secretsMissing) lines.push({ sign: '!', text: `Needs ${secret.name}, which is not set`, secret: secret.name })
  return lines
}

/** The sum of a source change: its files and the lines it adds and removes. */
export function diffTotals(files: readonly { additions: number; deletions: number }[]) {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return { files: files.length, additions, deletions }
}
