import { getContext, setContext } from 'svelte'
import type { Message } from '@solus/contracts/types'
import type { ReplyHtmlLayout } from '@solus/contracts/session-history'

/**
 * The reply an HTML block renders in, for the layout its history page read: the
 * frame's id and the heights the host stored for it. The block is rendered
 * from deep inside the markdown tree, where the reply's own props do not reach.
 */
type ReplyFrameMessage = Pick<Message, 'content' | 'replyHtmlLayout'>

const REPLY_FRAME_MESSAGE = Symbol('reply-frame-message')

export function setReplyFrameMessage(message: () => ReplyFrameMessage | undefined): void {
  setContext(REPLY_FRAME_MESSAGE, message)
}

export function getReplyFrameMessage(): (() => ReplyFrameMessage | undefined) | undefined {
  return getContext<(() => ReplyFrameMessage | undefined) | undefined>(REPLY_FRAME_MESSAGE)
}

/** The layout of the HTML fence whose body is `html`. A reply whose text
 *  changed since the page was read matches no frame. */
export function replyFrameLayoutOf(message: ReplyFrameMessage | undefined, html: string): ReplyHtmlLayout | undefined {
  for (const frame of message?.replyHtmlLayout ?? []) {
    if (frame.bodyEnd - frame.bodyStart === html.length && message!.content.slice(frame.bodyStart, frame.bodyEnd) === html) return frame
  }
  return undefined
}
