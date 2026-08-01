import { isNoReplyNotice } from '../../../contexts/workspace/session.utils'

export { isAgentNotice } from '../../../contexts/workspace/session.utils'

/** §1 — the transient family's third member, in the spec's own words. */
export const NO_REPLY_LABEL = 'No reply'

/** `[Request interrupted by user]` → `Request interrupted by user`. The provider's
 *  no-reply placeholder is a state, so it reads as one instead of as its own prose. */
export function noticeText(content: string): string {
  if (isNoReplyNotice(content)) return NO_REPLY_LABEL
  return content.trim().replace(/^\[/, '').replace(/\]$/, '')
}
