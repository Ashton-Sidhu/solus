import type { PrConversationItem } from '@solus/contracts/providers'

/** A conversation comment the viewer wrote, which the viewer may delete. A
 *  review body is not one: GitHub deletes a review only with its review.
 *  GitHub logins do not depend on case. */
export function isOwnConversationComment(item: PrConversationItem, viewerLogin: string | null): boolean {
  return item.kind === 'comment' && !!viewerLogin && item.author.toLowerCase() === viewerLogin.toLowerCase()
}
