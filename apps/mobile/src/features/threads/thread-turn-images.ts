import { messageReplyImages, replyImage, type ReplyImage } from '@solus/client-core/reply-images'
import { toolGalleryImages } from '@solus/client-core/tool-outputs'
import type { TranscriptItem } from '../conversation/lib/transcript-model'
import { toolCallOutputs } from './thread-work-log-presentation'

/** The images a turn's gallery shows: its replies, its images and captures,
 *  and the images its calls returned (docs/transcript-cards.md, "Tool outputs"). */
export function threadTurnImages(items: readonly TranscriptItem[]): ReplyImage[] {
  return items.flatMap((item) => {
    if (item.kind === 'assistant') return messageReplyImages(item)
    if (item.kind === 'image') return [replyImage(item.path)]
    if (item.kind === 'browser_snapshot') return [{ href: `asset://${item.snapshot.assetId}`, label: item.snapshot.title || 'Browser screenshot', format: 'PNG' }]
    if (item.kind === 'tool') return toolGalleryImages(toolCallOutputs(item))
    return []
  })
}
