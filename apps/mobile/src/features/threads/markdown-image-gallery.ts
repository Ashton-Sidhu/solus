import { replyImages } from '@solus/client-core/reply-images'
import type { FilePreviewItem } from '../../components/FilePreview.types'
import { resolveMarkdownMediaPreview, type MarkdownMediaContext } from '../../lib/markdownMedia'

/** As in T3's messageImageGallery: opening one image browses its message's images. */
export function markdownImageGallery(markdown: string, media: MarkdownMediaContext): FilePreviewItem[] {
  return replyImages(markdown).flatMap((image) => {
    const preview = resolveMarkdownMediaPreview(image.href, media, true)
    return preview?.kind === 'image' ? [preview.source] : []
  })
}
