import { messageReplyImages, replyImage, type ReplyImage } from '@solus/client-core/reply-images'
import type { TranscriptItem } from '../conversation/lib/transcript-model'

/** Agent output only: raw images returned by tools are work, not gallery output. */
export function threadTurnImages(items: readonly TranscriptItem[]): ReplyImage[] {
  return items.flatMap((item) => {
    if (item.kind === 'assistant') return messageReplyImages(item)
    if (item.kind === 'image') return [replyImage(item.path)]
    if (item.kind === 'browser_snapshot') return [{ href: `asset://${item.snapshot.assetId}`, label: item.snapshot.title || 'Browser screenshot', format: 'PNG' }]
    return []
  })
}
