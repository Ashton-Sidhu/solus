import type { ChangedFileStat, TurnSnapshot } from '@solus/contracts/git-types'
import { artifactLinkedAt, type SessionArtifact, type SessionArtifactKind, type SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { TurnSpan } from './session-artifact-chips'
import type { TimelineTurn } from './turn-timeline'

/**
 * What the Artifacts surface shows under its timeline
 * (docs/plans/session-artifacts.md): the session's changed files, its agents,
 * its pull requests, and its works and files, for the whole session or for one
 * turn. Desktop, web, and the phone scope and order the rows with this model.
 */

/** An artifact and the session that linked it. */
export interface OwnedArtifact {
  artifact: SessionArtifact
  ownerSessionId: string
  /** The name of the session that linked it, when that is a session this one started. Null for its own. */
  startedSessionTitle: string | null
}

/** The session's own artifacts, then those of each session it started. */
export function ownedArtifacts(artifacts: SessionArtifacts, sessionId: string): OwnedArtifact[] {
  return [
    ...artifacts.own.map((artifact) => ({ artifact, ownerSessionId: sessionId, startedSessionTitle: null })),
    ...artifacts.children.flatMap((group) =>
      group.items.map((artifact) => ({
        artifact,
        ownerSessionId: group.sessionId,
        startedSessionTitle: group.title?.trim() || 'Untitled session',
      })),
    ),
  ]
}

/** When a turn holds something: from its prompt until the next prompt. The last turn stays open. */
export function turnSpanAt(turns: readonly TimelineTurn[], index: number): TurnSpan {
  return { startedAt: turns[index]!.startedAt, nextStartedAt: turns[index + 1]?.startedAt ?? null }
}

/** Whether something that happened at `time` is in the scope. A null scope is the whole session. */
export function isInScope(scope: TurnSpan | null, time: number): boolean {
  if (!scope) return true
  return time >= scope.startedAt && (scope.nextStartedAt === null || time < scope.nextStartedAt)
}

export interface ScopedArtifacts {
  pullRequests: OwnedArtifact[]
  /** Works, then apps, then automations, then files, then images. */
  items: OwnedArtifact[]
}

const KIND_ORDER = { 'pull-request': 0, work: 1, app: 2, automation: 3, file: 4, image: 5 } satisfies { [Kind in SessionArtifactKind]: number }

/**
 * The linked artifacts of the scope, newest first inside each kind. A link is
 * in a turn when the session made it between that turn's prompt and the next.
 */
export function scopedArtifacts(
  owned: readonly OwnedArtifact[],
  scope: TurnSpan | null,
  matches: (artifact: SessionArtifact) => boolean,
): ScopedArtifacts {
  const shown = owned
    .filter(({ artifact }) => isInScope(scope, artifactLinkedAt(artifact)) && matches(artifact))
    .sort(
      (a, b) =>
        KIND_ORDER[a.artifact.kind] - KIND_ORDER[b.artifact.kind] || artifactLinkedAt(b.artifact) - artifactLinkedAt(a.artifact),
    )
  const firstItem = shown.findIndex(({ artifact }) => artifact.kind !== 'pull-request')
  return firstItem === -1
    ? { pullRequests: shown, items: [] }
    : { pullRequests: shown.slice(0, firstItem), items: shown.slice(firstItem) }
}

/**
 * The checkpoint a turn closed with. A snapshot is written when its turn ends:
 * after the turn's prompt and before the next one. When a turn ended more than
 * once (a retry), the last snapshot stands.
 */
export function turnSnapshotIn(snapshots: readonly TurnSnapshot[], scope: TurnSpan): TurnSnapshot | null {
  for (let index = snapshots.length - 1; index >= 0; index--) {
    if (isInScope(scope, snapshots[index]!.timestamp)) return snapshots[index]!
  }
  return null
}

/** One changed file. The counts and the status are null until git has answered. */
export interface OverviewChange {
  path: string
  additions: number | null
  deletions: number | null
  status: ChangedFileStat['status'] | null
}

/**
 * The changed files of the scope, the largest change first. Counts live in git:
 * with `stats` the rows carry them, and until they arrive (or where the project
 * has no git) the rows are the paths alone.
 */
export function overviewChanges(stats: readonly ChangedFileStat[], paths: readonly string[]): OverviewChange[] {
  if (stats.length === 0) {
    return paths.map((path) => ({ path, additions: null, deletions: null, status: null }))
  }
  return stats
    .map((stat) => ({ path: stat.path, additions: stat.additions, deletions: stat.deletions, status: stat.status }))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path))
}

/** The line totals of a list of changes. Null when none of its rows has counts yet. */
export function changeTotals(changes: readonly OverviewChange[]): { additions: number; deletions: number } | null {
  if (!changes.some((change) => change.additions !== null)) return null
  return {
    additions: changes.reduce((sum, change) => sum + (change.additions ?? 0), 0),
    deletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0),
  }
}
