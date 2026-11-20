import type { Message } from '@solus/contracts/types'
import { messageReplyImages, replyImage, toolResultImages, type ReplyImage } from '@solus/client-core/reply-images'
import { turnToolGallery } from '@solus/client-core/tool-outputs'

/** The images a message adds to its turn's gallery: an image artifact, or the
 *  images its reply links. A tool row's text adds none; the images a call
 *  returned join the gallery through `galleryEntries`. */
export function messageImages(message: Message): ReplyImage[] {
  if (message.artifact?.kind === 'image' && message.artifact.path) return [replyImage(message.artifact.path)]
  return message.role === 'tool' ? [] : messageReplyImages(message)
}

/** The images an open tool row shows. A call still running has none to decode. */
export function toolRowImages(tool: Message): ReplyImage[] {
  return tool.toolStatus === 'running' ? [] : toolResultImages(tool.toolImages)
}

/** The images a turn's gallery shows, as its replies name them. */
export function galleryHrefs(messages: Message[]): string[] {
  return messages.flatMap((message) => messageImages(message).map((image) => image.href))
}

/** Whether a turn's gallery has a slide. The carousel mounts only then: an
 *  empty one still measured itself, which forced a layout of the whole
 *  transcript for every turn a session opened with. */
export function hasGallerySlides(messages: Message[]): boolean {
  return messages.some((message) => !!message.browserSnapshot || messageImages(message).length > 0)
}

export type GalleryEntry =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'tool-image'; key: string; image: ReplyImage }

export interface TurnGallery {
  /** Replies, captures, and tool images, in the order they happened. */
  entries: GalleryEntry[]
  /** Every tool image of the turn, for the viewer the last card opens. */
  toolImages: ReplyImage[]
  /** The tool images past the gallery's limit, which the last card opens. */
  moreCount: number
}

/**
 * A turn's gallery: its replies and captures, and the images its calls
 * returned, each at the time of its call. It reads the turn's own messages
 * and tools only: the order from their timestamps, the images from the tools.
 * A streamed token changes neither, so it does not run again for one.
 */
export function turnGallery(messages: Message[], tools: Message[]): TurnGallery {
  const gallery = turnToolGallery(tools)
  const startedAt = new Map(tools.map((tool) => [tool.id, tool.timestamp]))
  const entries: GalleryEntry[] = []
  let next = 0
  for (const message of messages) {
    while (next < gallery.shown.length && (startedAt.get(gallery.shown[next].toolId) ?? 0) <= message.timestamp) {
      const { image } = gallery.shown[next++]
      entries.push({ kind: 'tool-image', key: image.href, image })
    }
    entries.push({ kind: 'message', key: message.id, message })
  }
  for (const { image } of gallery.shown.slice(next)) entries.push({ kind: 'tool-image', key: image.href, image })
  return { entries, toolImages: gallery.all, moreCount: gallery.moreCount }
}
