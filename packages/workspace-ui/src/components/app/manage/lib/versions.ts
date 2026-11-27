import type { AppDeployPreflight, AppVersionView } from '@solus/contracts/apps'
import { lastActivation, type AppChangeLogEntry } from '@solus/client-core/app-versions'
import { attributionLabel } from '@solus/contracts/user'
import { appTime } from '../../lib/app-view'
import { deliveryTime } from './app-webhook-deliveries'
import type { ManageState } from './states'
import { formatDuration } from '../../../insights/lib/format'

/** What one build holds: `4 operations · a UI · built in 977ms`. */
export function versionFactsText(version: Pick<AppVersionView, 'operationCount' | 'hasUi' | 'buildMs'>): string {
  const facts = [version.operationCount === 1 ? '1 operation' : `${version.operationCount} operations`, version.hasUi ? 'a UI' : 'no UI']
  if (version.buildMs !== null) facts.push(`built in ${formatDuration(version.buildMs)}`)
  return facts.join(' · ')
}

// ─── The history ───

/** The place of a save in the history: not deployed, live, built now, a failed build, or an earlier version. */
export type HistoryMark = 'ahead' | 'live' | 'building' | 'failed' | 'behind'

export function historyMark(entry: Pick<AppChangeLogEntry, 'position' | 'versions'>): HistoryMark {
  if (entry.position === 'live') return 'live'
  if (entry.versions[0]?.state === 'building') return 'building'
  if (entry.versions.length > 0 && entry.versions.every((version) => version.state === 'failed')) return 'failed'
  return entry.position
}

/** The session mark of a save: the live one is complete, a build in progress works, a failed build is an error, every other save is idle. */
const HISTORY_STATES = {
  ahead: 'idle',
  live: 'ok',
  building: 'running',
  failed: 'failed',
  behind: 'idle',
} satisfies { [Mark in HistoryMark]: ManageState }

export function historyState(entry: Pick<AppChangeLogEntry, 'position' | 'versions'>): ManageState {
  return HISTORY_STATES[historyMark(entry)]
}

/** The place in the source that a build error names, such as `app.ts:88`; null when it names none. */
export function buildErrorPlace(error: string): string | null {
  return error.match(/[\w./-]+\.[A-Za-z]+:\d+/)?.[0] ?? null
}

/** The quiet line under a save in the history; `isCode` sets it in code type. */
export interface HistoryMeta {
  text: string
  isCode: boolean
}

/**
 * The quiet line under a save in the history: "Saved 20 min ago" for a save
 * with no version, "v14 · 14:02 · Ashton" for the live one, "v13 · Tue" for
 * an earlier one. A failed build gives the place it names, in code type.
 */
export function historyMeta(entry: Pick<AppChangeLogEntry, 'position' | 'versions' | 'revision'>, nowMs: number): HistoryMeta {
  const mark = historyMark(entry)
  const newest = entry.versions[0] ?? null
  if (mark === 'failed') {
    const firstLine = newest?.error?.split('\n')[0]?.replace(/^The build failed: /, '') ?? ''
    const place = buildErrorPlace(firstLine)
    return place ? { text: place, isCode: true } : { text: firstLine || 'The build failed', isCode: false }
  }
  if (!newest || mark === 'ahead') return { text: `Saved ${appTime(entry.revision.savedAt, nowMs)}`, isCode: false }
  if (mark === 'behind') return { text: `v${newest.number} · ${deliveryTime(newest.createdAt, nowMs)}`, isCode: false }
  const since = mark === 'live' && newest.activations.length > 0 ? lastActivation(newest) : { at: newest.createdAt, by: newest.createdBy }
  return { text: `v${newest.number} · ${deliveryTime(since.at, nowMs)} · ${attributionLabel(since.by)}`, isCode: false }
}

/** The start of the line under the selected save: when it was saved, or which version it is. */
export function changeWhen(entry: Pick<AppChangeLogEntry, 'position' | 'versions' | 'revision'>, nowMs: number): string {
  const newest = entry.versions[0] ?? null
  if (!newest || entry.position === 'ahead') return `Saved ${appTime(entry.revision.savedAt, nowMs)}`
  return `v${newest.number} · ${deliveryTime(newest.createdAt, nowMs)}`
}

// ─── This deploy ───

/** One fact of "This deploy": the words of the change and the name it changes. A name that is code (a workflow, an operation) shows in code type. */
export interface PreflightLine {
  words: string
  name: string
  isCode: boolean
}

const CHANGE_WORDS: { key: Exclude<keyof AppDeployPreflight, 'commit' | 'against' | 'buildError' | 'secretsMissing'>; added: string; removed: string; isCode: boolean }[] = [
  { key: 'network', added: 'May reach', removed: 'No longer reaches', isCode: false },
  { key: 'readPaths', added: 'May read', removed: 'No longer reads', isCode: true },
  { key: 'writePaths', added: 'May write', removed: 'No longer writes', isCode: true },
  { key: 'models', added: 'Adds the model setting', removed: 'Removes the model setting', isCode: true },
  { key: 'integrations', added: 'Uses the integration', removed: 'No longer uses the integration', isCode: false },
  { key: 'workflows', added: 'Adds the workflow', removed: 'Removes the workflow', isCode: true },
  { key: 'schedules', added: 'Adds the schedule', removed: 'Removes the schedule', isCode: true },
  { key: 'webhooks', added: 'Adds the webhook', removed: 'Removes the webhook', isCode: true },
  { key: 'signals', added: 'Adds the signal', removed: 'Removes the signal', isCode: true },
  { key: 'operations', added: 'Adds the operation', removed: 'Removes the operation', isCode: true },
]

/** What a deploy of the revision changes, as plain facts: what it may now use, then what it declares. A failed build has none. */
export function preflightLines(preflight: AppDeployPreflight): PreflightLine[] {
  if (preflight.buildError) return []
  return CHANGE_WORDS.flatMap(({ key, added, removed, isCode }) => [
    ...preflight[key].added.map((name): PreflightLine => ({ words: added, name, isCode })),
    ...preflight[key].removed.map((name): PreflightLine => ({ words: removed, name, isCode })),
  ])
}

/** Why a deploy of the revision fails, for the error callout; null when the build passes. */
export function preflightBuildError(preflight: AppDeployPreflight): string | null {
  return preflight.buildError ? `The build fails: ${preflight.buildError.replace(/^The build failed: /, '')}` : null
}

/** The words after the names in the warning callout for secrets a deploy needs that have no value: "Needs A, which is not set. …". */
export function missingSecretsTail(count: number): string {
  return count === 1 ? ', which is not set. A step that reads it fails until you add it.' : ', which are not set. A step that reads them fails until you add them.'
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
