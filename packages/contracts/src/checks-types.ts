// Check state for a PR, read via one batched GraphQL statusCheckRollup query per
// repo (#14). The rollup is the only surface unifying check runs with commit
// statuses, and isRequired(pullRequestNumber:) resolves required-ness with a
// plain `repo` token — no branch-protection read, which is what `unknown`
// existed to paper over.

/** One check's terminal state, normalized across CheckRun.conclusion and
 *  StatusContext.state (the rollup mixes both; consumers must not care which). */
export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'skipped'
  | 'stale'

export interface CheckItem {
  /** Stable across polls, for keyed rendering: CheckRun.databaseId as a string,
   *  or StatusContext.context (its name is its identity). */
  id: string
  name: string
  /** Null while the check is still running — inFlight distinguishes that from a
   *  check that finished with no conclusion. */
  conclusion: CheckConclusion | null
  inFlight: boolean
  /** Where a human reads the log. WS1 excludes log viewing, so this is the one
   *  alt-tab the workstream deliberately leaves in place. */
  detailsUrl: string | null
  /** Publisher ("GitHub Actions", "CircleCI") — disambiguates same-named checks
   *  from different apps, which is common in migrated repos. */
  appName: string | null
  startedAt: string | null
  completedAt: string | null
}

/** No `unknown` — #14 removed the ambiguity that produced it. `none` means the
 *  rollup is null (no CI configured): permanent, expected, and NOT passing.
 *  Transient API failure is a load failure and belongs to the store. */
export type PrChecksState = 'pending' | 'passing' | 'failing' | 'none'

export interface PrChecksSummary {
  /** Rolled up over `required` ONLY — optional failures never gate a merge, so a
   *  rollup that counted them would make WS2 refuse to land a landable PR.
   *  Surfaces wanting "something failed" read `optional` directly. */
  state: PrChecksState
  required: CheckItem[]
  optional: CheckItem[]
  /** The commit these ran against. Checks are stale the instant the head moves,
   *  so consumers compare against the PR's current headSha rather than trusting
   *  freshness. */
  headSha: string
  /** Any required check in flight. Drives cadence per #14 (10s active-with-CI →
   *  60s background → paused when hidden) — a summary-level field so the poller
   *  never re-scans the arrays to decide its own interval. */
  inFlight: boolean
}
