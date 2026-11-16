import type { AppRevisionView, AppVersionView } from '@solus/contracts/apps'
import type { Attribution } from '@solus/contracts/user'

/**
 * The history of one app's source and of what ran, as the Versions section
 * shows it on desktop, web, and mobile (docs/plans/apps.md §9.2). Two lines:
 *
 * - the change log: the revisions on `main`, the newest first, each placed
 *   against the revision that runs now (ahead of it, it, or behind it);
 * - the deploy history: each build, and each time a version became active,
 *   so a rollback and a roll forward show with who did it and when.
 *
 * Pure, so the clients draw the same history and the tests pin it.
 */

/** Where a revision is against the revision that runs now. */
export type AppRevisionPosition = 'ahead' | 'live' | 'behind'

export interface AppChangeLogEntry {
  revision: AppRevisionView
  position: AppRevisionPosition
  /** The versions built from this revision, the newest first. */
  versions: AppVersionView[]
  /** No version of it built: the owner deploys it. A revision whose builds all failed can be deployed again. */
  canDeploy: boolean
  /** The newest version of it that ran before and can run again. */
  restorable: AppVersionView | null
}

/** What runs now, and how it stands against the history. */
export interface AppLiveState {
  /** The active version; null when no deploy succeeded yet. */
  live: AppVersionView | null
  /** The version the host builds now. */
  building: AppVersionView | null
  /** The newest version that ran and is newer than the live one: the app runs a rollback from it. */
  rolledBackFrom: AppVersionView | null
  /** The saves after the live revision, the newest first: the source that does not run. */
  ahead: AppRevisionView[]
}

export type AppDeployEventKind = 'deploy' | 'rollback' | 'roll-forward' | 'failed' | 'building'

/** One line of the deploy history. */
export interface AppDeployEvent {
  kind: AppDeployEventKind
  at: number
  by: Attribution
  version: AppVersionView
  /** The version that ran before this one became active; null for the first, a failed build, and one that builds. */
  previous: number | null
  /** The revision of `previous`: a rollback compares the two revisions it moved between. */
  previousRevision: string | null
  /** The activation that put the live version in place: the newest one, while its version is still active. */
  isLive: boolean
}

/** A version that ran before and can run again. */
export function canActivate(version: Pick<AppVersionView, 'state'>): boolean {
  return version.state === 'superseded'
}

/** The version that builds now, when one does. */
export function buildingVersion(versions: readonly AppVersionView[]): AppVersionView | null {
  return versions.find((version) => version.state === 'building') ?? null
}

/** A commit as a person reads it. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

/**
 * Where the live revision is in the list, the newest first. With no version
 * live, or a live revision older than the list holds, every listed save is
 * ahead of it: the answer is the length of the list.
 */
function liveRevisionIndex(revisions: readonly AppRevisionView[], live: AppVersionView | null): number {
  const index = live ? revisions.findIndex((revision) => revision.commit === live.revision) : -1
  return index === -1 ? revisions.length : index
}

export function liveState(revisions: readonly AppRevisionView[], versions: readonly AppVersionView[]): AppLiveState {
  const live = versions.find((version) => version.state === 'active') ?? null
  const rolledBackFrom = live
    ? versions.filter((version) => version.state === 'superseded' && version.number > live.number).sort((a, b) => b.number - a.number)[0] ?? null
    : null
  return { live, building: buildingVersion(versions), rolledBackFrom, ahead: revisions.slice(0, liveRevisionIndex(revisions, live)) }
}

/** The change log: each revision, the newest first, with the versions built from it. */
export function changeLog(revisions: readonly AppRevisionView[], versions: readonly AppVersionView[]): AppChangeLogEntry[] {
  const liveIndex = liveRevisionIndex(revisions, versions.find((version) => version.state === 'active') ?? null)
  return revisions.map((revision, index) => {
    const built = versions.filter((version) => version.revision === revision.commit).sort((a, b) => b.number - a.number)
    return {
      revision,
      position: index < liveIndex ? 'ahead' : index === liveIndex ? 'live' : 'behind',
      versions: built,
      canDeploy: built.every((version) => version.state === 'failed'),
      restorable: built.find(canActivate) ?? null,
    }
  })
}

/**
 * The deploy history, the newest first. A version's first activation is its
 * deploy; each later one moved the app back to it or forward to it. A failed
 * build and a build in progress show at the time the build started.
 */
export function deployHistory(versions: readonly AppVersionView[]): AppDeployEvent[] {
  const revisionOf = new Map(versions.map((version) => [version.number, version.revision]))
  const events: AppDeployEvent[] = []
  for (const version of versions) {
    if (version.state === 'failed' || version.state === 'building') {
      events.push({ kind: version.state, at: version.createdAt, by: version.createdBy, version, previous: null, previousRevision: null, isLive: false })
      continue
    }
    version.activations.forEach((activation, index) => {
      const kind: AppDeployEventKind = index === 0 ? 'deploy' : activation.previous !== null && version.number < activation.previous ? 'rollback' : 'roll-forward'
      events.push({ kind, at: activation.at, by: activation.by, version, previous: activation.previous, previousRevision: activation.previous === null ? null : revisionOf.get(activation.previous) ?? null, isLive: false })
    })
  }
  events.sort((a, b) => b.at - a.at || b.version.number - a.version.number)
  const newestActivation = events.find((event) => event.kind !== 'failed' && event.kind !== 'building')
  if (newestActivation?.version.state === 'active') newestActivation.isLive = true
  return events
}

/** When and by whom a version last became active: since then it runs. A version that never did answers its build. */
export function lastActivation(version: AppVersionView): { at: number; by: Attribution } {
  return version.activations.at(-1) ?? { at: version.createdAt, by: version.createdBy }
}

/** Whether making a version active moves the app back or forward from the live one. */
export function activationDirection(target: number, live: number | null): 'rollback' | 'roll-forward' {
  return live !== null && target < live ? 'rollback' : 'roll-forward'
}

/** The words of the control that makes a version active. */
export function activationLabel(target: number, live: number | null): string {
  return activationDirection(target, live) === 'rollback' ? `Roll back to v${target}` : `Roll forward to v${target}`
}

/** The question before a version is made active: what runs, and what is not rewound. */
export function activationConfirmation(target: number, live: number | null) {
  return {
    title: `${activationLabel(target, live)}?`,
    message: `Version ${target} runs from now. Its data is not rewound: what later versions wrote stays as it is.`,
  }
}

/** The title of one line of the deploy history. */
export function deployEventTitle(event: Pick<AppDeployEvent, 'kind' | 'version'>): string {
  const name = `v${event.version.number}`
  switch (event.kind) {
    case 'deploy': return `Deployed ${name}`
    case 'rollback': return `Rolled back to ${name}`
    case 'roll-forward': return `Rolled forward to ${name}`
    case 'failed': return `${name} failed`
    case 'building': return `Building ${name}`
  }
}

/** What one line of the deploy history replaced or moved from. */
export function deployEventDetail(event: Pick<AppDeployEvent, 'kind' | 'previous' | 'version'>): string {
  switch (event.kind) {
    case 'deploy': return event.previous === null ? 'The first version that ran' : `Replaced v${event.previous}`
    case 'rollback':
    case 'roll-forward': return event.previous === null ? 'No version ran before' : `From v${event.previous}`
    case 'failed': return event.version.error ?? 'The build or the start failed. The version before it still runs.'
    case 'building': return 'The host builds this version now.'
  }
}

/** How much a revision changed: `5 files · +120 −34`. */
export function revisionStatsText(stats: AppRevisionView['stats']): string {
  if (stats.files === 0) return 'No file changed'
  return `${stats.files === 1 ? '1 file' : `${stats.files} files`} · +${stats.additions} −${stats.deletions}`
}
