import { CHAT_ROUTE, type RouteRef } from './routing/route-registry'

/** What the workspace knows that routing does not, when the leading pane
 *  needs somewhere to rest. */
export interface LeadingHomeInput {
  /** Whether the conversation pool has a tab to show. */
  hasTabs: boolean
  /** The leading pane's own content at the moment of closing. */
  leadingBase: RouteRef | null
  /** Every open draft, oldest first — `workspace.sessionDrafts`. */
  drafts: ReadonlyMap<string, { id: string }>
  /** The drafts some pane is composing right now. */
  composingDraftIds: ReadonlySet<string>
  /** Mint a fresh draft, when no existing one can be home. */
  createDraft: () => { id: string }
}

/**
 * Where the leading pane lands when the page, artifact, or review it held
 * closes. With a tab open that is the conversation, as it always was. With
 * none, the pool would render nothing above the input bar, so the composer is
 * home instead — the same rule closing the last tab and booting empty follow.
 */
export function leadingHomeRoute(input: LeadingHomeInput): RouteRef {
  if (input.hasTabs) return CHAT_ROUTE
  const { leadingBase } = input
  // A composer already in the lead is home: closing it with nothing behind
  // it is a no-op rather than a hand-off to yet another draft.
  if (leadingBase?.name === 'draft' && input.drafts.has(leadingBase.params.draftId)) {
    return leadingBase
  }
  // The draft the page covered is still in the map, unlisted because no pane
  // shows it. The newest such draft is the one the user was writing when they
  // left; a draft another pane is composing is spoken for.
  let covered: { id: string } | null = null
  for (const draft of input.drafts.values()) {
    if (!input.composingDraftIds.has(draft.id)) covered = draft
  }
  const draft = covered ?? input.createDraft()
  return { name: 'draft', params: { draftId: draft.id } }
}
