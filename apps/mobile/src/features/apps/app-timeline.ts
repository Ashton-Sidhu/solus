import type { AppRevisionView, AppVersionView } from '@solus/contracts/apps'
import type { RowLine } from '../webhooks/webhook-rows'
import { agoText } from './apps'

/**
 * The Versions section (docs/plans/apps.md §9.2): the revisions and the
 * versions of an app in one timeline. A save makes a revision and changes
 * nothing that runs; a deploy builds a version from a revision (decision 6).
 */

export type AppTimelineItem =
  | { readonly kind: 'revision'; readonly at: number; readonly revision: AppRevisionView; /** The newest save: with no version, it waits for a deploy. */ readonly isNewest: boolean }
  | { readonly kind: 'version'; readonly at: number; readonly version: AppVersionView }

/**
 * The saves and the builds of an app, the newest first. A version is built
 * after its revision is saved, so it shows above it; at the same instant the
 * version still shows first.
 */
export function appTimeline(revisions: readonly AppRevisionView[], versions: readonly AppVersionView[]): AppTimelineItem[] {
  const newestSave = Math.max(...revisions.map((revision) => revision.savedAt))
  const items: AppTimelineItem[] = [
    ...versions.map((version): AppTimelineItem => ({ kind: 'version', at: version.createdAt, version })),
    ...revisions.map((revision): AppTimelineItem => ({ kind: 'revision', at: revision.savedAt, revision, isNewest: revision.savedAt === newestSave })),
  ]
  return items.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at
    if (a.kind !== b.kind) return a.kind === 'version' ? -1 : 1
    return a.kind === 'version' && b.kind === 'version' ? b.version.number - a.version.number : 0
  })
}

/** The key of one timeline row. */
export function timelineKey(item: AppTimelineItem): string {
  return item.kind === 'version' ? `version:${item.version.number}` : `revision:${item.revision.commit}`
}

/**
 * Whether the owner can deploy a revision from the phone: no build is in
 * progress, and no version of the revision was built. A revision whose only
 * versions failed can be deployed again. One with a version that ran is made
 * active from that version, not built a second time.
 */
export function canDeploy(revision: Pick<AppRevisionView, 'commit'>, versions: readonly Pick<AppVersionView, 'revision' | 'state'>[]): boolean {
  if (versions.some((version) => version.state === 'building')) return false
  return versions.filter((version) => version.revision === revision.commit).every((version) => version.state === 'failed')
}

/** The lines of one revision: when it was saved, and what was built from it. */
export function revisionLines(revision: AppRevisionView, isNewest: boolean, now: number): RowLine[] {
  const built = revision.versions.length === 0
    ? isNewest ? 'Waits for a deploy' : 'Not deployed'
    : `Built as ${revision.versions.map((version) => `v${version}`).join(', ')}`
  return [{ text: `Saved ${agoText(revision.savedAt, now)}` }, { text: built }]
}
