import type { CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'
import { isFailing, type ChecksPresentation } from '../../prs/lib/checks'
import type { MergeAction } from '../../pr-review/lib/merge-readiness'

/**
 * The words beside the checks glyph on the pull request row: the failures if
 * any, else the checks still running, else nothing — a green glyph says "all
 * passed" by itself. A result read against an older head is not asserted.
 */
export function checksButtonLabel(
  presentation: ChecksPresentation,
  summary: PrChecksSummary | undefined,
): string | null {
  if (presentation.state === 'unavailable') return 'Unavailable'
  if (!summary || presentation.stale) return 'Checking'
  const items = [...summary.required, ...summary.optional]
  const failed = items.filter(isFailing).length
  if (failed > 0) return `${failed} failed`
  const running = items.filter((item) => item.inFlight).length
  if (running > 0) return `${running} running`
  return null
}

export interface ChecksPopoverModel {
  heading: string
  /** "3 of 7 failing", "2 of 7 running", "All checks passed". */
  summary: string
  /** Failed checks, cancelled ones included: what a reader acts on. */
  attention: CheckItem[]
  running: CheckItem[]
  completed: CheckItem[]
  /** The completed checks fold behind "Show all" while anything else needs a look. */
  foldsCompleted: boolean
}

/** What the checks popover says: the problem first, the rest folded. */
export function checksPopover(summary: PrChecksSummary | undefined): ChecksPopoverModel {
  const items = summary ? [...summary.required, ...summary.optional] : []
  const attention = items.filter(isFailing)
  const running = items.filter((item) => item.inFlight)
  const completed = items.filter((item) => !item.inFlight && !isFailing(item))
  const total = items.length
  const heading =
    total === 0
      ? 'No checks reported'
      : attention.length > 0
        ? 'Some checks were not successful'
        : running.length > 0
          ? 'Some checks haven’t completed yet'
          : 'All checks have passed'
  const summaryLine =
    total === 0
      ? ''
      : attention.length > 0
        ? `${attention.length} of ${total} failing`
        : running.length > 0
          ? `${running.length} of ${total} running`
          : 'All checks passed'
  return {
    heading,
    summary: summaryLine,
    attention,
    running,
    completed,
    foldsCompleted: attention.length + running.length > 0 && completed.length > 0,
  }
}

/** The one short verb for the pull request's next move, at the end of the
 *  row's second line. The full label of the move is its tooltip. */
export function nextMoveLabel(kind: MergeAction['kind']): string {
  switch (kind) {
    case 'merge': return 'Merge'
    case 'enable-auto-merge': return 'Auto-merge'
    case 'mark-ready': return 'Ready'
    case 'resolve-conflicts': return 'Resolve'
    case 'fix-checks': return 'Fix'
    case 'update-branch': return 'Update'
  }
}

/** The moves that hand the pull request to an agent in a new session draft. */
export function nextMoveOpensDraft(kind: MergeAction['kind']): boolean {
  return kind === 'fix-checks' || kind === 'resolve-conflicts'
}
