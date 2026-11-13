import type { AppRevisionView, AppVersionView } from '@solus/contracts/apps'

/**
 * The Versions section (docs/plans/apps.md §9.2): the revisions and the
 * versions of one app in one timeline. A revision is one save; a version is
 * one build of one revision. Pure, so the join is tested.
 */

export interface TimelineEntry {
  /** The revision's commit. */
  commit: string
  message: string
  /** When the revision was saved; for a revision the host did not list, when its first version was made. */
  savedAt: number
  /** False when a version names a revision that the list of revisions does not hold. */
  isListed: boolean
  /** The newest revision of the app. */
  isNewest: boolean
  /** The versions built from this revision, the newest first. */
  versions: AppVersionView[]
  /** No build of this revision is active, builds now, or can be made active: the owner deploys it. */
  canDeploy: boolean
}

/** A version the owner can make active: a build that worked and does not run now. */
export function canActivate(version: Pick<AppVersionView, 'state'>): boolean {
  return version.state === 'superseded'
}

/**
 * The timeline, the newest revision first. Each revision carries the versions
 * built from it. A revision with no version, or whose builds all failed, can
 * be deployed. A version whose revision is not in the list keeps its place by
 * its own time.
 */
export function appTimeline(revisions: readonly AppRevisionView[], versions: readonly AppVersionView[]): TimelineEntry[] {
  const versionsByCommit = new Map<string, AppVersionView[]>()
  for (const version of versions) {
    const built = versionsByCommit.get(version.revision)
    if (built) built.push(version)
    else versionsByCommit.set(version.revision, [version])
  }
  const newest = revisions.reduce<AppRevisionView | null>((latest, revision) => (latest && latest.savedAt >= revision.savedAt ? latest : revision), null)
  const entry = (commit: string, message: string, savedAt: number, isListed: boolean): TimelineEntry => {
    const built = (versionsByCommit.get(commit) ?? []).sort((a, b) => b.number - a.number)
    return { commit, message, savedAt, isListed, isNewest: newest?.commit === commit, versions: built, canDeploy: isListed && built.every((version) => version.state === 'failed') }
  }
  const listed = new Set(revisions.map((revision) => revision.commit))
  const entries = revisions.map((revision) => entry(revision.commit, revision.message, revision.savedAt, true))
  for (const [commit, built] of versionsByCommit) {
    if (listed.has(commit)) continue
    const first = built.reduce((earliest, version) => (version.createdAt < earliest.createdAt ? version : earliest))
    entries.push(entry(commit, first.message, first.createdAt, false))
  }
  return entries.sort((a, b) => b.savedAt - a.savedAt)
}

/** The version that builds now, when one does: the page shows it while a deploy has no answer yet. */
export function buildingVersion(versions: readonly AppVersionView[]): AppVersionView | null {
  return versions.find((version) => version.state === 'building') ?? null
}

/** A commit as a person reads it. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}
