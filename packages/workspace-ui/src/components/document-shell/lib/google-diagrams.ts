import { findDiagramEmbeds } from '@solus/contracts/diagram-embed'
import { renderDiagramSvg } from '@solus/contracts/diagram-svg'
import { parseDiagram } from '@solus/contracts/diagram-types'
import type { GoogleDiagramAsset, Work } from '@solus/contracts/types'
import { svgToPngBase64 } from '../../diagram/lib/svg-to-png'

const MAX_DIAGRAMS = 20
const MAX_SVG_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_SVG_BYTES = 10 * 1024 * 1024

export async function buildGoogleDiagramAssets(
  markdown: string,
  loadWork: (workId: string) => Promise<Work | null>,
  encodePng: (svg: string) => Promise<string> = svgToPngBase64,
): Promise<GoogleDiagramAsset[]> {
  const unique = new Map(findDiagramEmbeds(markdown).map((reference) => [reference.workId, reference]))
  if (unique.size > MAX_DIAGRAMS) throw new Error(`Google upload supports at most ${MAX_DIAGRAMS} unique diagrams.`)

  let totalSvgBytes = 0
  const assets: GoogleDiagramAsset[] = []
  for (const reference of unique.values()) {
    const work = await loadWork(reference.workId)
    if (!work) throw new Error(`Diagram “${reference.title}” is unavailable.`)
    if (work.type !== 'diagram') throw new Error(`“${work.title}” is not a diagram.`)
    const svg = renderDiagramSvg(parseDiagram(work.content))
    const svgBytes = new TextEncoder().encode(svg).byteLength
    if (svgBytes > MAX_SVG_BYTES) throw new Error(`Diagram “${work.title}” is too large to upload.`)
    totalSvgBytes += svgBytes
    if (totalSvgBytes > MAX_TOTAL_SVG_BYTES) throw new Error('The embedded diagrams are too large to upload together.')
    assets.push({
      workId: work.id,
      title: work.title,
      mimeType: 'image/png',
      base64: await encodePng(svg),
    })
  }
  return assets
}
