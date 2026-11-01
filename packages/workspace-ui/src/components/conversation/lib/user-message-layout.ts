import type { Attachment, OutboundPromptState } from '@solus/contracts/types'
import { formatFileSize } from '../../files/lib/non-text-file'
import { attachmentLabel } from '../../../lib/attachment-label'

/**
 * How a person's message draws what it carried. Pictures and videos are shapes
 * of their own above the text bubble; files are chips beside the words, or
 * cards when there are no words to sit beside.
 */
export interface UserMessageLayout {
  /** One picture keeps its own aspect ratio; several share one collage. */
  images: 'none' | 'lone' | 'collage'
  /** Files sent alone are cards; sent with words they stay chips. */
  files: 'none' | 'chips' | 'cards'
  /** The bubble meets media above it, so its top-right corner tightens. */
  bubbleMeetsMedia: boolean
}

export function userMessageLayout(input: {
  hasText: boolean
  imageCount: number
  videoCount: number
  fileCount: number
}): UserMessageLayout {
  const images = input.imageCount === 0 ? 'none' : input.imageCount === 1 ? 'lone' : 'collage'
  const files = input.fileCount === 0 ? 'none' : input.hasText ? 'chips' : 'cards'
  return { images, files, bubbleMeetsMedia: input.hasText && input.imageCount + input.videoCount > 0 }
}

/**
 * Where one picture sits in a collage: two side by side, three as a tall lead
 * and two stacked, more in pairs with an odd last one across the width.
 */
/** Where one picture sits in a collage. */
export interface CollageCell {
  spansRows: boolean
  spansColumns: boolean
}

export function collageCell(count: number, index: number): CollageCell {
  return {
    spansRows: count === 3 && index === 0,
    spansColumns: count > 3 && count % 2 === 1 && index === count - 1,
  }
}

/** The short type a file card names: its extension, or File. */
export function fileTypeLabel(name: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toUpperCase() ?? 'File'
}

/**
 * A file card's second line. A prompt still on its way says so in place of its
 * type and size, so the card keeps its height when the prompt lands.
 */
export function fileCardDetail(
  attachment: Pick<Attachment, 'type' | 'name' | 'size'>,
  deliveryState: 'sent' | OutboundPromptState,
): string {
  if (deliveryState === 'steering' || deliveryState === 'queueing') return 'Sending…'
  const label = attachmentLabel(attachment)
  // A paste has no type the reader chose; its size is what tells pastes apart.
  const type = label === attachment.name ? fileTypeLabel(attachment.name) : 'Text'
  return attachment.size ? `${type} · ${formatFileSize(attachment.size)}` : type
}
