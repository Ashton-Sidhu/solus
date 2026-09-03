import { findDiagramEmbeds } from '@solus/contracts/diagram-embed'
import type { Work } from '@solus/contracts/types'
import type { DocDiagramAsset } from '@solus/contracts/docs'

const MAX_DIAGRAMS = 20
/** The server accepts 48 MB of PNG per publish; base64 carries three bytes in four. */
const MAX_TOTAL_PNG_BASE64_BYTES = 64 * 1024 * 1024

/** Renders one diagram work as a base64 PNG for the destination document, or
 *  `null` when it has nothing to draw. How a diagram is drawn is the
 *  provider's question — laid out for a page for Google Docs, as authored for
 *  Confluence — so the caller supplies it and this only collects the results. */
export type DocumentDiagramRenderer = (work: Work) => Promise<string | null>

export async function buildDiagramAssets(
  markdown: string,
  loadWork: (workId: string) => Promise<Work | null>,
  render: DocumentDiagramRenderer,
): Promise<DocDiagramAsset[]> {
  const unique = new Map(findDiagramEmbeds(markdown).map((reference) => [reference.workId, reference]))
  if (unique.size > MAX_DIAGRAMS) throw new Error(`A document can include at most ${MAX_DIAGRAMS} unique diagrams.`)

  let totalBytes = 0
  const assets: DocDiagramAsset[] = []
  // One at a time: each render mounts a canvas, and a plan with twenty
  // diagrams should never hold twenty of them at once.
  for (const reference of unique.values()) {
    const work = await loadWork(reference.workId)
    if (!work) throw new Error(`Diagram “${reference.title}” is unavailable.`)
    if (work.type !== 'diagram') throw new Error(`“${work.title}” is not a diagram.`)
    const base64 = await render(work)
    if (!base64) throw new Error(`Diagram “${work.title}” is empty, so there is nothing to publish for it.`)
    totalBytes += base64.length
    if (totalBytes > MAX_TOTAL_PNG_BASE64_BYTES) throw new Error('The embedded diagrams are too large to upload together.')
    assets.push({ workId: work.id, title: work.title, mimeType: 'image/png', base64 })
  }
  return assets
}
