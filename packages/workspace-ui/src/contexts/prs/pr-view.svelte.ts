// How this client is looking at pull requests.
//
// Not facts about them — those are `PrsStore`, keyed by project, and behind it
// the server's index. This is where the reader is: which project is on screen,
// how the list was left, which tab is open, and, when they are working a queue,
// which pull requests it was launched with.
//
// It lives outside the components that read it because the review surface is a
// pane route: opening a pull request destroys `PrsPage`, and leaving the review
// destroys `PrReviewPane`. State that has to survive that crossing cannot be
// local to either of them.

import type { IpcContext } from '@solus/contracts/types'
import { emptyListView, type PrListView } from '../../components/prs/lib/prs-list-view'

/** Chat is NOT a content tab — it is the primary conversation, toggled by
 *  `maximized`. */
export type PrReviewTab = 'activity' | 'map' | 'guide' | 'diff'

export class PrView {
  /** The project the PRs page is showing, as a `projectPrsKey`. */
  activeProjectKey = $state('')

  /**
   * How the list was left: query, narrowing, and reading position.
   *
   * Here rather than in `PrsPage` because opening a pull request routes the pane
   * away from that page and destroys it, so a local would forget the review it
   * just came back from. One record, not one per project: switching project
   * resets it, so keying it by project only ever described the one on screen.
   */
  listView = $state<PrListView>(emptyListView())

  /** The visible rows in list order, so the review chrome's stepper cannot
   *  drift from the list behind it. */
  listOrder = $state<number[]>([])

  /** Forget how the list was left. Only a change of project earns this —
   *  opening the page must not throw away the position a review returned to. */
  resetListView(): void {
    this.listView = emptyListView()
    this.listOrder = []
  }

  /** The open content tab. Lifted out of `PrReviewPane` so the chrome around it
   *  can react to the selection. */
  tab = $state<PrReviewTab>('guide')

  /**
   * The fixed launch snapshot for Review Mode.
   *
   * Taken once and not re-read: the session owns its own ordering and
   * dispositions from then on, so a list refresh behind it cannot move the pull
   * request the reader is on.
   */
  reviewModeNumbers = $state<number[]>([])
  reviewModeContext = $state<IpcContext | null>(null)
  reviewModeServerId = $state<string | null>(null)

  beginReviewMode(numbers: number[], ctx: IpcContext, serverId: string): void {
    // Spliced rather than reassigned: a new array identity would invalidate
    // every `$derived` reading the queue, on a list that can be long.
    this.reviewModeNumbers.splice(0, this.reviewModeNumbers.length, ...numbers)
    this.reviewModeContext = ctx
    this.reviewModeServerId = serverId
  }
}
