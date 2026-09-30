/**
 * Local asset references inside task Markdown.
 *
 * Durable Markdown keeps `asset://<digest>.<extension>` forever, per ADR-0015.
 * Publishing derives a separate body carrying provider URLs; it never writes
 * that body back over the stored one.
 */

const ASSET_ID = String.raw`[a-f0-9]{64}\.[a-z0-9][a-z0-9+_-]{0,15}`

/** A reference as it appears in Markdown: an image, a link, or a bare URL. */
const ASSET_REFERENCE = new RegExp(
  String.raw`(!?)\[([^\]]*)\]\(asset:\/\/(${ASSET_ID})\)|(?:^|[\s(])asset:\/\/(${ASSET_ID})(?=$|[\s)])`,
  'gi',
)

export interface AssetReference {
  assetId: string
  extension: string
  /** Alt or link text the author wrote. Empty for a bare URL. */
  label: string
  /** True when the author wrote it as an image, so it should stay one. */
  isImage: boolean
}

export function containsLocalAsset(body: string): boolean {
  return assetReferencesIn(body).length > 0
}

export function assetReferencesIn(body: string): AssetReference[] {
  const references: AssetReference[] = []
  for (const match of body.matchAll(ASSET_REFERENCE)) {
    const assetId = (match[3] ?? match[4] ?? '').toLowerCase()
    if (!assetId) continue
    references.push({
      assetId,
      extension: assetId.split('.').pop() ?? '',
      label: match[2] ?? '',
      isImage: match[1] === '!',
    })
  }
  return references
}

/**
 * Replace every reference whose asset has a provider URL. A reference with no
 * entry in `urlByAssetId` is left exactly as it was, so a partial publication
 * cannot silently drop an attachment from the body.
 */
export function withPublishedAssets(
  body: string,
  urlByAssetId: Map<string, string>,
  renderReference: (reference: AssetReference, url: string) => string,
): string {
  return body.replace(ASSET_REFERENCE, (raw, bang: string, label: string, linkedId: string, bareId: string) => {
    const assetId = (linkedId ?? bareId ?? '').toLowerCase()
    const url = urlByAssetId.get(assetId)
    if (!url) return raw
    const rendered = renderReference(
      { assetId, extension: assetId.split('.').pop() ?? '', label: label ?? '', isImage: bang === '!' },
      url,
    )
    // A bare reference matches its leading separator too, so put it back rather
    // than gluing the replacement onto the previous word. Its trailing boundary
    // is a lookahead, so nothing follows the id inside the match.
    if (!linkedId) {
      const separator = raw.slice(0, raw.length - `asset://${bareId}`.length)
      return `${separator}${rendered}`
    }
    return rendered
  })
}
