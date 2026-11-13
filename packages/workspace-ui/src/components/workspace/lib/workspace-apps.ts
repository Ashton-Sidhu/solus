import type { AppSummary } from '@solus/contracts/apps'
import { hostPathBaseName } from '@solus/contracts/host-path'
import { projectKeyLabel } from '@solus/client-core/project-identity'
import type { AppRow } from '../../../contexts/apps/apps.store.svelte'
import { appProblems, type AppProblem } from '../../app/lib/app-view'
import { appRunState, type AppRunState } from '../../app/manage/lib/overview'
import { bucketFor, inTimeBucket, type SortOrder, type WorkspaceFilter } from './workspace-items'

/**
 * One app as the Apps tab of the Workspace page shows it (docs/plans/apps.md
 * §9.3, docs/workspace-page.md): the host that runs it, its state, its active
 * version, the calls of the last 24 hours, the project it was first saved
 * from, its last call, and what needs the owner.
 */
export interface WorkspaceAppItem {
  rowKey: string
  serverId: string
  appId: string
  /** What the app's route goes by. */
  slug: string
  title: string
  description: string
  /** The host, as this client names it. */
  hostLabel: string
  /** The version that runs; null when no deploy succeeded yet. */
  activeVersion: number | null
  /** Running, stopped, with no version, or with a version that the host builds now. */
  state: AppRunState
  /** The calls of the last 24 hours, and how many of them failed. */
  calls24h: number
  failed24h: number
  /** The newest revision has no version: a save waits for a deploy. */
  hasUndeployedRevision: boolean
  /** The logical project the app belongs to, in the key space the works use; empty with no project. */
  projectKey: string
  /** The project's name in the Project filter. */
  projectLabel: string
  /** The last segment of the folder the app was first deployed from; empty with no folder. */
  folderName: string
  lastCallAt: number | null
  /** When the app last moved: its last change or its last call, epoch ms. */
  timestamp: number
  /** What needs the owner, each with the section of the Manage page where they act. Stopped is the state, not a problem. */
  problems: AppProblem[]
  app: AppSummary
}

/** How the tab names hosts and projects, from the stores the page reads. */
export interface WorkspaceAppSources {
  hostLabel(serverId: string): string
  /** The project of an app that has a folder, in the key space the works use. */
  projectKeyOf(serverId: string, folder: string): string
  optionsFor(projectKeys: Iterable<string>): { key: string; label: string }[]
}

/** Every app of every connected host, newest activity first. */
export function buildWorkspaceAppItems(rows: readonly AppRow[], sources: WorkspaceAppSources): WorkspaceAppItem[] {
  const keys = rows.map((row) => (row.app.project ? sources.projectKeyOf(row.serverId, row.app.project) : ''))
  const labels = new Map(sources.optionsFor(keys.filter(Boolean)).map((option) => [option.key, option.label]))
  const items = rows.map((row, index): WorkspaceAppItem => {
    const { app, serverId } = row
    const projectKey = keys[index]!
    return {
      rowKey: `app:${serverId}:${app.id}`,
      serverId,
      appId: app.id,
      slug: app.slug,
      title: app.name,
      description: app.description,
      hostLabel: sources.hostLabel(serverId),
      activeVersion: app.activeVersion,
      state: appRunState(app),
      calls24h: app.calls24h,
      failed24h: app.failed24h,
      hasUndeployedRevision: app.hasUndeployedRevision,
      projectKey,
      projectLabel: projectKey ? labels.get(projectKey) || projectKeyLabel(projectKey) || 'No project' : 'No project',
      folderName: app.project ? hostPathBaseName(app.project) || app.project : '',
      lastCallAt: app.lastCallAt,
      timestamp: Math.max(app.updatedAt, app.lastCallAt ?? 0),
      problems: appProblems(app),
      app,
    }
  })
  return items.sort((a, b) => b.timestamp - a.timestamp)
}

/**
 * The apps a filter keeps. An app has a project and a time, so those facets
 * and the search apply; the type, pin, and review facets cut works only.
 */
export function applyAppFilter(items: WorkspaceAppItem[], filter: Pick<WorkspaceFilter, 'text' | 'time' | 'project'>, now = new Date()): WorkspaceAppItem[] {
  const query = filter.text.trim().toLowerCase()
  return items.filter((item) => {
    if (!inTimeBucket(item.timestamp, filter.time, now)) return false
    if (filter.project && item.projectKey !== filter.project) return false
    if (!query) return true
    return [item.title, item.description, item.slug, item.hostLabel, item.folderName].some((text) => text.toLowerCase().includes(query))
  })
}

export function sortAppItems(items: WorkspaceAppItem[], order: SortOrder): WorkspaceAppItem[] {
  return [...items].sort((a, b) => (order === 'oldest' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp))
}

export type AppGroup = { key: string; label: string; items: WorkspaceAppItem[] }

/** The ledger's date buckets, in the order the items come in. */
export function groupAppItems(items: WorkspaceAppItem[], now = new Date()): AppGroup[] {
  const groups: AppGroup[] = []
  const byKey = new Map<string, AppGroup>()
  for (const item of items) {
    const bucket = bucketFor(item.timestamp, now)
    let group = byKey.get(bucket.key)
    if (!group) {
      group = { key: bucket.key, label: bucket.label, items: [] }
      byKey.set(bucket.key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

/** The Project filter's options for the apps: every project that holds one, by name, each with its count. */
export function appProjectOptions(items: WorkspaceAppItem[]): { value: string; label: string; count: number }[] {
  const byKey = new Map<string, { value: string; label: string; count: number }>()
  for (const item of items) {
    if (!item.projectKey) continue
    const option = byKey.get(item.projectKey)
    if (option) option.count++
    else byKey.set(item.projectKey, { value: item.projectKey, label: item.projectLabel, count: 1 })
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** How many apps each Time option holds. */
/** The calls of the last 24 hours in a few words: "No calls", "12 calls", "12 calls, 2 failed". */
export function calls24hText(item: Pick<WorkspaceAppItem, 'calls24h' | 'failed24h'>): string {
  // A connected host can run an older version that does not send these counts.
  if (!Number.isFinite(item.calls24h) || !Number.isFinite(item.failed24h)) return 'Call counts unavailable'
  if (item.calls24h === 0) return 'No calls in 24 hours'
  const calls = item.calls24h === 1 ? '1 call' : `${item.calls24h.toLocaleString()} calls`
  return item.failed24h === 0 ? `${calls} in 24 hours` : `${calls} in 24 hours, ${item.failed24h.toLocaleString()} failed`
}

export function appTimeCounts(items: WorkspaceAppItem[], now = new Date()) {
  const counts = { today: 0, yesterday: 0, week: 0, older: 0 }
  for (const item of items) {
    const key = bucketFor(item.timestamp, now).key
    if (key === 'today' || key === 'yesterday' || key === 'week') counts[key]++
    else counts.older++
  }
  return counts
}
