import type { AppAttention, AppRunView, AppState, AppSummary } from '@solus/contracts/apps'
import type { AppSymbolName } from '../../components/AppSymbol'
import type { RowLine } from '../webhooks/webhook-rows'
import { appStateLabel, countText, failedCallsText, versionLabel } from './apps'

/**
 * The sections of the Manage screen (docs/plans/apps.md §9.2), in the order
 * of the plan. The phone shows them as a list: each row says the one fact a
 * person scans for, and opens the screen of its section.
 */
export const APP_SECTIONS = [
  { id: 'overview', title: 'Overview', icon: 'gauge' },
  { id: 'activity', title: 'Activity', icon: 'chart.bar.xaxis' },
  { id: 'workflows', title: 'Workflows', icon: 'flowchart' },
  { id: 'versions', title: 'Versions', icon: 'square.3.layers.3d' },
  { id: 'schedules', title: 'Schedules', icon: 'clock' },
  { id: 'webhooks', title: 'Webhooks', icon: 'link' },
  { id: 'signals', title: 'Signals', icon: 'bell.badge' },
  { id: 'models', title: 'Models', icon: 'sparkles' },
  { id: 'secrets', title: 'Secrets', icon: 'lock' },
  { id: 'config', title: 'Config', icon: 'slider.horizontal.3' },
  { id: 'files', title: 'Files', icon: 'folder' },
  { id: 'operations', title: 'Operations', icon: 'terminal' },
  { id: 'sessions', title: 'Sessions', icon: 'text.bubble' },
  { id: 'source', title: 'Source', icon: 'chevron.left.forwardslash.chevron.right' },
] as const satisfies readonly { id: string; title: string; icon: AppSymbolName }[]

export type AppSectionId = (typeof APP_SECTIONS)[number]['id']

export function appSectionTitle(id: AppSectionId): string {
  return APP_SECTIONS.find((section) => section.id === id)?.title ?? 'App'
}

/** The section where the owner acts on one problem. */
export function attentionSection(kind: AppAttention['kind']): AppSectionId {
  switch (kind) {
    case 'version-failed': return 'versions'
    case 'secret-missing': return 'secrets'
    case 'schedule-failed': return 'schedules'
    case 'workflow-failed': return 'workflows'
    case 'stopped': return 'overview'
  }
}

/** One problem the owner must act on, with the section where they act. */
export interface AppProblem {
  readonly detail: string
  readonly section: AppSectionId
}

/** The problems at the top of the Manage screen. Stopped is the owner's own choice, so it is not one. */
export function appProblems(app: Pick<AppSummary, 'attention'>): AppProblem[] {
  return app.attention
    .filter((attention) => attention.kind !== 'stopped')
    .map((attention) => ({ detail: attention.detail, section: attentionSection(attention.kind) }))
}

/** One row of the Manage screen. */
export interface AppSectionRow {
  readonly id: AppSectionId
  readonly title: string
  readonly icon: AppSymbolName
  readonly summary: RowLine
}

const NO_VERSION: RowLine = { text: 'No version is active' }

function hasAttention(app: AppSummary, kind: AppAttention['kind']): boolean {
  return app.attention.some((attention) => attention.kind === kind)
}

/** What a section of declared things says: how many, or that the app declares none. */
function declaredSummary(count: number | undefined, one: string): RowLine {
  if (count === undefined) return NO_VERSION
  return { text: count === 0 ? `This app declares no ${one}` : countText(count, one) }
}

function workflowsSummary(state: AppState, runs: readonly AppRunView[] | null): RowLine {
  if (hasAttention(state.app, 'workflow-failed')) return { text: 'The last run of a workflow failed', tone: 'danger' }
  const declared = declaredSummary(state.descriptor?.workflows.length, 'workflow')
  if (!state.descriptor || state.descriptor.workflows.length === 0 || !runs) return declared
  const running = runs.filter((run) => run.state === 'running').length
  const sleeping = runs.filter((run) => run.state === 'sleeping').length
  if (running === 0 && sleeping === 0) return { text: 'No run in progress' }
  return { text: [running > 0 ? `${running} running` : null, sleeping > 0 ? `${sleeping} sleeping` : null].filter(Boolean).join(' · ') }
}

function versionsSummary(app: AppSummary): RowLine {
  if (hasAttention(app, 'version-failed')) return { text: 'The newest version failed', tone: 'danger' }
  if (app.hasUndeployedRevision) return { text: '1 waits for a deploy' }
  return { text: app.activeVersion === null ? 'No version yet' : `${versionLabel(app.activeVersion)} is active` }
}

function secretsSummary(state: AppState): RowLine {
  if (state.secrets.length === 0) return { text: 'This app declares no secret' }
  const missing = state.secrets.filter((secret) => !secret.isSet).length
  return missing > 0 ? { text: `${missing} not set`, tone: 'danger' } : { text: `${state.secrets.length} set` }
}

function overviewSummary(app: AppSummary): RowLine {
  return { text: app.activeVersion === null ? appStateLabel(app) : `${appStateLabel(app)} · ${versionLabel(app.activeVersion)}` }
}

function activitySummary(app: AppSummary): RowLine {
  if (!Number.isFinite(app.calls24h) || !Number.isFinite(app.failed24h)) return { text: 'Call counts unavailable' }
  const failed = failedCallsText(app)
  if (failed) return { text: failed, tone: 'danger' }
  return { text: app.calls24h === 0 ? 'No calls in 24 h' : `${countText(app.calls24h, 'call')} in 24 h` }
}

function schedulesSummary(state: AppState): RowLine {
  if (hasAttention(state.app, 'schedule-failed')) return { text: 'The last run of a schedule failed', tone: 'danger' }
  return declaredSummary(state.descriptor?.schedules.length, 'schedule')
}

function operationsSummary(state: AppState): RowLine {
  if (!state.descriptor) return NO_VERSION
  return { text: `${countText(state.descriptor.operations.length, 'operation')} · agent access ${state.app.agentAccess ? 'on' : 'off'}` }
}

function sectionSummary(id: AppSectionId, state: AppState, runs: readonly AppRunView[] | null): RowLine {
  switch (id) {
    case 'overview': return overviewSummary(state.app)
    case 'activity': return activitySummary(state.app)
    case 'workflows': return workflowsSummary(state, runs)
    case 'versions': return versionsSummary(state.app)
    case 'schedules': return schedulesSummary(state)
    case 'webhooks': return declaredSummary(state.descriptor?.webhooks.length, 'webhook')
    case 'signals': return declaredSummary(state.descriptor?.signals.length, 'signal')
    case 'models': return declaredSummary(state.descriptor?.config.filter((field) => field.type === 'model').length, 'model setting')
    case 'secrets': return secretsSummary(state)
    case 'config': return state.descriptor ? { text: state.config.length === 0 ? 'This app declares no config' : countText(state.config.length, 'setting') } : NO_VERSION
    case 'files': return { text: 'Upload, share, and delete' }
    case 'operations': return operationsSummary(state)
    case 'sessions': return { text: 'The sessions that made or changed this app' }
    case 'source': return { text: state.app.slug }
  }
}

/**
 * The rows of the Manage screen. `runs` is the app's runs when they are read:
 * the summary of Workflows counts those in progress. Every other summary
 * comes from the app's state, so the screen needs no read for each section.
 */
export function appSectionRows(state: AppState, runs: readonly AppRunView[] | null): AppSectionRow[] {
  return APP_SECTIONS.map((section) => ({ ...section, summary: sectionSummary(section.id, state, runs) }))
}

const APP_ROUTE_NAMES: ReadonlySet<string> = new Set(['App', 'AppManage', 'AppSection', 'AppCall', 'AppRun', 'AppBuildLog', 'AppOperation'])

/**
 * How many routes on top of the stack show one app: what a delete pops, so
 * the person lands where they opened the app from.
 */
export function appRoutesOnTop(routes: readonly { readonly name: string }[], index: number): number {
  let count = 0
  for (let at = index; at >= 0 && APP_ROUTE_NAMES.has(routes[at]?.name ?? ''); at--) {
    count++
    if (routes[at]?.name === 'App') break
  }
  return count
}
