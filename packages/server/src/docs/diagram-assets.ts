import type { DocDiagramAsset } from '@solus/contracts/docs'

/** A publish is a request from a client, so the images it carries are checked
 *  before any provider is asked to store them: a bounded number, a bounded
 *  size, and PNG bytes rather than whatever the caller named. */
const MAX_DIAGRAMS = 20
/** A figure drawn for a reader zoomed to 200% is tens of megapixels, so a few
 *  of them in one document run to tens of megabytes. The transport does not
 *  bound an RPC, so this is the only bound, and it is a refusal with a reason
 *  rather than a stalled publish. */
const MAX_TOTAL_BYTES = 48 * 1024 * 1024

export function validatedDiagramAssets(assets: DocDiagramAsset[] | undefined): DocDiagramAsset[] {
  if (!assets?.length) return []
  if (assets.length > MAX_DIAGRAMS) throw new Error(`A document can include at most ${MAX_DIAGRAMS} unique diagrams.`)
  let totalBytes = 0
  for (const asset of assets) {
    const bytes = Buffer.from(asset.base64, 'base64')
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('The embedded diagrams are too large to publish together.')
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      throw new Error(`Diagram “${asset.title}” is not a valid PNG image.`)
    }
  }
  return assets
}
