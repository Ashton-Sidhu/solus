import type { Message } from '@solus/contracts/types'
import { messageReplyImages, replyImage, type ReplyImage } from '@solus/client-core/reply-images'

/** The images a message adds to its turn's gallery: an image artifact, or the
 *  images its reply links. A tool row adds none. */
export function messageImages(message: Message): ReplyImage[] {
  if (message.artifact?.kind === 'image' && message.artifact.path) return [replyImage(message.artifact.path)]
  return message.role === 'tool' ? [] : messageReplyImages(message)
}

/** Whether a turn's gallery has a slide. The carousel mounts only then: an
 *  empty one still measured itself, which forced a layout of the whole
 *  transcript for every turn a session opened with. */
export function hasGallerySlides(messages: Message[]): boolean {
  return messages.some((message) => !!message.browserSnapshot || messageImages(message).length > 0)
}
