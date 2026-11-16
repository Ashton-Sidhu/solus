import { lastActivation } from '@solus/client-core/app-versions'
import type { AppCallKind, AppCallView, AppScheduleView, AppSessionLink, AppSummary, AppVersionView } from '@solus/contracts/apps'
import { attributionLabel } from '@solus/contracts/user'
import type { RowLine } from '../webhooks/webhook-rows'
import { agoText, callTitle, triggerText, versionLabel } from './apps'
import { scheduleNextRunText } from './app-schedules'
import { versionState, type AppItemState } from './app-states'
import type { Loadable } from './use-app'

/**
 * The words of the Overview on the phone (docs/plans/apps.md §9.2): who the
 * app is, what the owner calls it, the version that runs, the newest failed
 * calls and deploys, the schedules, and where the app and its source came from. The same
 * capability as the desktop and web Overview.
 */

/** How many failed calls and deploys the Overview shows. The Activity and Versions sections show all. */
export const RECENT_FAILURE_COUNT = 5
export const RECENT_DEPLOY_COUNT = 3

/** The longest error line a row shows. The call screen shows the full error. */
const ERROR_LINE_MAX = 120

/** The line under the app's name: its slug, the version that runs, and its host. */
export function appMetaLine(app: Pick<AppSummary, 'slug' | 'activeVersion'>, hostLabel: string | null): string {
  return [app.slug, app.activeVersion === null ? null : versionLabel(app.activeVersion), hostLabel].filter(Boolean).join(' · ')
}

/**
 * The change that a typed name or description makes: `undefined` when it is
 * the text the app has now, so a blur sends nothing; `null` when it is empty,
 * so the manifest's text shows again; else the text without the spaces around it.
 */
export function textPatch(draft: string, current: string): string | null | undefined {
  const text = draft.trim()
  if (text === current) return undefined
  return text || null
}

/** The note under the Name field: where the name shows, or the app's own name the owner can go back to. */
export function nameNote(app: Pick<AppSummary, 'name' | 'manifestName'>): string {
  return app.name === app.manifestName ? 'The app list, the sidebar, and agents show this name.' : `The app's own name is "${app.manifestName}".`
}

export function descriptionNote(app: Pick<AppSummary, 'description' | 'manifestDescription'>): string {
  return app.description === app.manifestDescription ? 'One line on what the app does.' : "Your own words. Reset to show the app's description."
}

/** What agent access means for this app, as the Status card says it. Operations has the switch. */
export function agentAccessText(app: Pick<AppSummary, 'agentAccess' | 'operationCount'>): string {
  if (!app.agentAccess) return 'Agents cannot call this app.'
  return app.operationCount === 1 ? 'Agents can call its operation as a tool.' : `Agents can call its ${app.operationCount} operations as tools.`
}

/** The first line of an error, short enough for one row. */
export function oneLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  return line.length > ERROR_LINE_MAX ? `${line.slice(0, ERROR_LINE_MAX - 1).trimEnd()}…` : line
}

/** The Version row of the Status card: the version that runs, and when and by whom it was deployed when the versions are read. */
export function activeVersionDescription(
  app: Pick<AppSummary, 'activeVersion' | 'hasUndeployedRevision'>,
  versions: readonly AppVersionView[] | null,
  now: number,
): string | undefined {
  const lines: string[] = []
  const live = app.activeVersion === null ? undefined : versions?.find((version) => version.number === app.activeVersion)
  if (live) {
    const since = lastActivation(live)
    lines.push(`Deployed ${agoText(since.at, now)} by ${attributionLabel(since.by)}`)
  }
  if (app.hasUndeployedRevision) lines.push('A newer save waits for a deploy.')
  return lines.join('\n') || undefined
}

/** One row of Recent failures: what failed, its first error line, and when. A row opens its call. */
export interface FailureRow {
  readonly callId: string
  readonly kind: AppCallKind
  readonly title: string
  readonly trailing: string
  readonly lines: readonly RowLine[]
}

/** The newest failed calls, the newest first. */
export function recentFailureRows(calls: readonly AppCallView[], now: number): FailureRow[] {
  return [...calls]
    .filter((call) => call.outcome === 'failed')
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, RECENT_FAILURE_COUNT)
    .map((call) => ({
      callId: call.id,
      kind: call.kind,
      title: callTitle(call),
      trailing: agoText(call.startedAt, now),
      lines: [{ text: oneLine(call.error ?? '') || 'Failed', tone: 'danger' }],
    }))
}

/** One row of Recent deploys. */
export interface DeployRow {
  readonly number: number
  readonly title: string
  /** How the version stands, for the mark of the row. */
  readonly state: AppItemState
  readonly lines: readonly RowLine[]
}

function versionStateLabel(state: AppVersionView['state']): string | null {
  switch (state) {
    case 'active': return 'Active'
    case 'failed': return 'Failed'
    case 'building': return 'Building'
    case 'superseded': return null
  }
}

/**
 * The newest versions, the newest first: what was deployed, then how it
 * ended, by whom, and when. A version that ran before says no state; a
 * failed one says it as a failure.
 */
export function recentDeployRows(versions: readonly AppVersionView[], now: number): DeployRow[] {
  return [...versions]
    .sort((a, b) => b.number - a.number)
    .slice(0, RECENT_DEPLOY_COUNT)
    .map((version) => {
      const facts = [versionStateLabel(version.state), attributionLabel(version.createdBy), agoText(version.createdAt, now)].filter(Boolean).join(' · ')
      return {
        number: version.number,
        title: `Version ${version.number}`,
        state: versionState(version.state),
        lines: [{ text: oneLine(version.message) || 'No message' }, version.state === 'failed' ? { text: facts, tone: 'danger' } : { text: facts }],
      }
    })
}

/** One schedule of the Overview: when it runs, and when it runs next. */
export function scheduleOverviewLine(schedule: AppScheduleView, appStopped: boolean, now: number): string {
  return `${triggerText(schedule.trigger)} · Next: ${scheduleNextRunText(schedule, appStopped, now)}`
}

/** Who made the app and on which day: `Ada · Nov 13, 2026`. */
export function madeByText(app: Pick<AppSummary, 'createdBy' | 'createdAt'>): string {
  const day = new Date(app.createdAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
  return `${attributionLabel(app.createdBy)} · ${day}`
}

/**
 * The line under Sessions: how many sessions worked on the app, or why the
 * count does not show. A count it has not read is never shown as zero.
 */
export function sessionsLine(read: Loadable<readonly AppSessionLink[]>, connected: boolean): string {
  if (read.kind === 'loaded') {
    const count = read.value.length
    if (count === 0) return 'No session is linked to this app.'
    return `${count === 1 ? '1 session' : `${count} sessions`} worked on this app.`
  }
  if (!connected) return 'The count shows when this host is connected.'
  if (read.kind === 'error') return `Not read: ${read.message}`
  return 'Reading…'
}

/** What the newest save is to the versions: built, waiting, or not there. */
export function revisionNote(app: Pick<AppSummary, 'latestRevision' | 'hasUndeployedRevision'>): string {
  if (app.latestRevision === null) return 'Nothing was saved yet.'
  return app.hasUndeployedRevision ? 'It waits for a deploy.' : 'A version was built from it.'
}
