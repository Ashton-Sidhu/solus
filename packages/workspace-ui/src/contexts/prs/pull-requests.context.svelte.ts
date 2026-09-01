// Pull request state shared by every workspace surface.
//
// None of these objects belongs to an agent session. They are keyed by host and
// project, or they describe the one PR surface the client is showing. Keeping
// the aggregate in app context makes that ownership explicit without turning
// WorkspaceContext into the home of another domain.

import { createAppContext } from '../app/create-app-context'
import { PrChecksStore } from './pr-checks.store.svelte'
import { PrGuidesStore } from './pr-guides.store.svelte'
import { PrNeedsReviewStore } from './pr-needs-review.store.svelte'
import { PrView } from './pr-view.svelte'
import { PrsStore } from './prs.store.svelte'
import { StacksStore } from './stacks.store.svelte'

export class PullRequestsContext {
  readonly projects = new PrsStore()
  readonly view = new PrView()
  readonly guides = new PrGuidesStore(this.projects)
  readonly checks = new PrChecksStore()
  readonly needsReview = new PrNeedsReviewStore(this.projects)
  readonly stacks = new StacksStore()
}

export const [getPullRequestsContext, setPullRequestsContext] =
  createAppContext<PullRequestsContext>('pull-requests')
