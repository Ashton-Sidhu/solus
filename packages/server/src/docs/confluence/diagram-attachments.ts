import { z } from 'zod'
import type { DocDiagramAsset } from '@solus/contracts/docs'
import { SCROLLING_FIGURE_MAX_WIDTH, scrollingFigureWidth } from '@solus/contracts/diagram-page'
import { atlassianRequest, type AtlassianFailure } from '../../atlassian/api'
import { pngPixelSize } from '../png'

/**
 * Solus diagrams on a Confluence page.
 *
 * Confluence shows an image only from an attachment on the page itself
 * (`<ri:attachment>`) or from a URL it can fetch anonymously. A rendered
 * diagram is neither, so it is uploaded as an attachment and the storage
 * format points at it by filename.
 *
 * The filename carries the work id, which is what makes the round trip
 * self-describing: a pull reads `solus-diagram-<workId>.png` back into the
 * `work://embed` token without the link having to remember anything. It is
 * also why a republish replaces the attachment instead of adding a second
 * copy — the name is the same every time.
 */

const FILENAME_PREFIX = 'solus-diagram-'
const FILENAME_SUFFIX = '.png'
/** Ids are UUIDs today. Anything outside this set could not survive the
 *  filename round trip, so it is refused rather than quietly mangled. */
const WORK_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

export function diagramAttachmentFilename(workId: string): string {
  if (!WORK_ID_PATTERN.test(workId)) {
    throw new Error(`Diagram "${workId}" cannot be attached to a Confluence page: its id is not a usable filename.`)
  }
  return `${FILENAME_PREFIX}${workId}${FILENAME_SUFFIX}`
}

/** The work a page attachment holds the diagram for, or null when the
 *  attachment is something a person added. */
export function diagramAttachmentWorkId(filename: string): string | null {
  if (!filename.startsWith(FILENAME_PREFIX) || !filename.endsWith(FILENAME_SUFFIX)) return null
  const workId = filename.slice(FILENAME_PREFIX.length, -FILENAME_SUFFIX.length)
  return WORK_ID_PATTERN.test(workId) ? workId : null
}

/**
 * A Confluence page is one column wide, whatever the picture is. An image with
 * no stated width renders at its own pixel size, so a wide diagram would push
 * the page sideways; this is the width the reader sees, and the attachment
 * behind it keeps the full resolution for anyone who opens it.
 */
export interface DiagramAttachment {
  filename: string
  /** What to draw it at, in page pixels. */
  widthPx: number
}

/** Which diagrams this publish carries, by work id, for the storage renderer.
 *  A diagram with no asset keeps its caption fallback. */
export function diagramAttachments(assets: DocDiagramAsset[]): Map<string, DiagramAttachment> {
  return new Map(assets.map((asset) => {
    // The capture is sized against where the figure will appear. Recovering
    // that width from its pixels keeps the target resolution true even if a
    // very tall export had to stop at the raster pixel ceiling.
    const png = pngPixelSize(Buffer.from(asset.base64, 'base64'))
    return [asset.workId, {
      filename: diagramAttachmentFilename(asset.workId),
      widthPx: Math.max(1, Math.round(png ? scrollingFigureWidth(png.width) : SCROLLING_FIGURE_MAX_WIDTH)),
    }]
  }))
}

/**
 * The scope the upload needs. Uploading an attachment has no v2 endpoint, so
 * it runs on the v1 API, and v1 honours the classic file scope — a token
 * carrying only the granular `write:attachment:confluence` is refused with a
 * 401 there. A grant made before Solus published diagrams has neither, and
 * signing in again is the only way to add one, so it is reported here rather
 * than discovered halfway through a publish.
 */
export const ATTACHMENT_SCOPE = 'write:confluence-file'

export function canAttachDiagrams(scopes: readonly string[]): boolean {
  return scopes.includes(ATTACHMENT_SCOPE)
}

export const ATTACHMENT_SCOPE_MISSING =
  'This Atlassian connection was granted before Solus published diagrams to Confluence. Disconnect and sign in again in Settings → Providers to publish them as pictures.'

/**
 * Put every diagram on the page.
 *
 * `PUT` on the attachment collection is create-or-update by filename; `POST`
 * refuses a name the page already carries, which is every republish. One
 * request per diagram, so a refusal names the diagram it was about.
 */
export async function uploadDiagramAttachments(
  cloudId: string,
  pageId: string,
  assets: DocDiagramAsset[],
  failure: (failure: AtlassianFailure) => Error,
): Promise<void> {
  for (const asset of assets) {
    const filename = diagramAttachmentFilename(asset.workId)
    const body = new FormData()
    body.append('file', new Blob([Buffer.from(asset.base64, 'base64')], { type: asset.mimeType }), filename)
    // Otherwise every republish notifies everyone watching the page.
    body.append('minorEdit', 'true')
    body.append('comment', `Diagram “${asset.title}” published from Solus`)

    await atlassianRequest(
      {
        product: 'confluence',
        cloudId,
        path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`,
        method: 'PUT',
        body,
        failure,
      },
      z.unknown(),
    )
  }
}
