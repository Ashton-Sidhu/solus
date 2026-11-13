import { changeFilterOptions, changedFileKind, type ChangeKind } from '@solus/client-core/change-breakdown'
import type { OverviewChange } from '@solus/client-core/session-overview'

/**
 * The kinds of a change (Code, Tests, Mocks, Generated, Docs), for the line
 * and the chips over the Changes card's tree
 * (docs/plans/session-artifacts.md). These are the kinds the review surface
 * filters a diff by, so the same change reads the same way in both places.
 */
export interface ChangeKindShare {
  kind: ChangeKind
  label: string
  fileCount: number
  /** The kind's part of the change, 0..1: of its changed lines, or of its files until git has counted the lines. */
  share: number
}

/** The kinds the changes touch, in display order. */
export function changeKindShares(changes: readonly OverviewChange[]): ChangeKindShare[] {
  const parts = changeFilterOptions(
    changes.map((change) => ({ path: change.path, additions: change.additions ?? 0, deletions: change.deletions ?? 0 })),
  )
  const lines = parts.reduce((sum, part) => sum + part.additions + part.deletions, 0)
  return parts.flatMap((part) => {
    const fileCount = changes.filter((change) => changedFileKind(change.path) === part.kind).length
    if (fileCount === 0) return []
    const share = lines > 0 ? (part.additions + part.deletions) / lines : fileCount / changes.length
    return [{ kind: part.kind, label: part.label, fileCount, share }]
  })
}

/** The changes of one kind. A null kind is every change. */
export function changesOfKind(changes: readonly OverviewChange[], kind: ChangeKind | null): readonly OverviewChange[] {
  return kind === null ? changes : changes.filter((change) => changedFileKind(change.path) === kind)
}
