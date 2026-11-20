import type { PrConversationItem, PullRequestOverview, ReviewThread } from './providers'
export type PrReactionContent =
  'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'HOORAY' | 'CONFUSED' | 'HEART' | 'ROCKET' | 'EYES'
export interface PrReaction {
  content: PrReactionContent
  count: number
  viewerHasReacted: boolean
  /** Up to ten logins of the people who reacted, never the viewer: the
   *  viewer is `viewerHasReacted`. `count` can be larger. */
  actors: string[]
}
/**
 * The reactions on one pull request, conversation comment, review, or inline
 * comment, read with it. Like `viewerPermissions`, the viewer fields are the
 * host's one code-host identity (`server/src/prs/pull-request.ts`).
 */
export interface PrReactions {
  /** False when the viewer may not react: a locked conversation, an archived
   *  repository, or no access. The reactions still show. */
  viewerCanReact: boolean
  /** The reactions someone made, in GitHub's order. None has a count of zero. */
  groups: PrReaction[]
}
export interface PrUrlInspection {
  overview: PullRequestOverview
  comments: PrConversationItem[]
  threads: ReviewThread[]
  readOnly: true
  truncated: boolean
}
