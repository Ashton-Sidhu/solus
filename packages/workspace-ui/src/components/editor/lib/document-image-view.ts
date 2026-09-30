import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { DocumentImage } from '@solus/document-model/image'
import { serverConnections } from '@solus/client-core/server-connections'
import { assetUrlCache } from '../../artifact/lib/asset-url'
import { markdownAssetId, type MarkdownImageContext } from '../../conversation/lib/markdown-image'

/** The URL an image shows for the `src` it stores: the same string for an
 *  ordinary URL, a signed URL from the image's host for `asset://…`. */
export type ImageSourceResolver = (src: string) => string | Promise<string>

/**
 * A resolver that signs `asset://` references through the host the document
 * belongs to. Without a host (an ad-hoc preview), the reference is shown as
 * written.
 */
export function assetImageResolver(context: MarkdownImageContext | undefined): ImageSourceResolver {
  return (src) => {
    const assetId = markdownAssetId(src)
    const serverId = context?.serverId()
    const api = context?.api()
    if (!assetId || !serverId || !api) return src
    return assetUrlCache.resolve({
      serverId,
      assetId,
      origin: serverConnections.httpOriginFor(serverId),
      api,
      ctx: context?.ctx(),
    })
  }
}

/**
 * Keeps one image element's shown URL on its node's current `src`.
 *
 * Signing a URL is a round trip to the host. By the time it answers, the view
 * may show another image, or ProseMirror may have destroyed it; the answer is
 * then dropped rather than painted over the newer image.
 */
export class ImageSourceBinding {
  private requestedSrc: string | null = null
  private isDestroyed = false

  constructor(
    private readonly resolve: ImageSourceResolver,
    private readonly show: (url: string) => void,
  ) {}

  setSource(src: string): void {
    if (this.isDestroyed || src === this.requestedSrc) return
    this.requestedSrc = src
    const resolved = this.resolve(src)
    if (!(resolved instanceof Promise)) {
      this.show(resolved)
      return
    }
    const showIfCurrent = (url: string) => {
      if (!this.isDestroyed && this.requestedSrc === src) this.show(url)
    }
    // A reference the host cannot sign is shown as written, as before.
    resolved.then(showIfCurrent, () => showIfCurrent(src))
  }

  destroy(): void {
    this.isDestroyed = true
  }
}

const SHOWN_ATTRIBUTES = ['alt', 'title', 'width', 'height'] as const

function applyAttributes(img: HTMLImageElement, node: ProseMirrorNode): void {
  for (const name of SHOWN_ATTRIBUTES) {
    const value = node.attrs[name]
    if (value === null || value === undefined || value === '') img.removeAttribute(name)
    else img.setAttribute(name, String(value))
  }
}

/**
 * The document image with a view that resolves its display URL. The node's
 * `src` — and so the saved markdown, a copy, and an export — keeps the stable
 * reference; only the element's `src` holds the signed URL.
 */
export function createDocumentImageView(resolve: ImageSourceResolver) {
  return DocumentImage.extend({
    addNodeView() {
      return ({ node }) => {
        const img = document.createElement('img')
        const binding = new ImageSourceBinding(resolve, (url) => img.setAttribute('src', url))
        applyAttributes(img, node)
        binding.setSource(String(node.attrs.src ?? ''))
        return {
          dom: img,
          update(next) {
            if (next.type.name !== node.type.name) return false
            applyAttributes(img, next)
            binding.setSource(String(next.attrs.src ?? ''))
            return true
          },
          destroy() {
            binding.destroy()
          },
        }
      }
    },
  })
}
