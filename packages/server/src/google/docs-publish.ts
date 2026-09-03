import type { DocDiagramAsset } from '@solus/contracts/docs'
import { createLogger } from '../logger'
import { pngPixelSize } from '../docs/png'
import { appendIndex, batchUpdateDocument, getDocument, type DocsDocument, type DocsStructuralElement } from './docs-api'
import {
  BODY_START,
  blockRequests,
  compileDocsBlocks,
  fitImageToPage,
  sectionStyleRequest,
  tableRequests,
  type DocsImage,
  type RunBlock,
} from './docs-requests'
import { deleteFile, fileContentUrl, shareByLink, uploadPng } from './drive'

const log = createLogger('google', 'docs-publish.ts')

function lastTable(doc: DocsDocument): DocsStructuralElement | null {
  const content = doc.body?.content ?? []
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index].table) return content[index]
  }
  return null
}

/**
 * Replace a Google Doc's body with a markdown document.
 *
 * Paragraphs and images go up in one batch per run. A table is inserted
 * empty, the document is read back to learn where its cells landed, and the
 * cells are filled; then the run continues from the new end of the body.
 * Diagram PNGs are staged as link-readable Drive files only for as long as
 * the insert takes.
 */
export async function writeDocsBody(
  accessToken: string,
  documentId: string,
  markdown: string,
  assets: DocDiagramAsset[],
  folderId?: string,
): Promise<void> {
  const staged: string[] = []
  try {
    const images: DocsImage[] = []
    for (const asset of assets) {
      const png = Buffer.from(asset.base64, 'base64')
      const size = pngPixelSize(png)
      if (!size) throw new Error(`Diagram “${asset.title}” is not a readable PNG.`)
      const fileId = await uploadPng(accessToken, `${asset.title}.png`, png, folderId)
      staged.push(fileId)
      await shareByLink(accessToken, fileId)
      const placement = fitImageToPage(size)
      // The resolution the reader actually gets, in one greppable line: a
      // figure that looks soft is either short of pixels here or is being
      // downscaled by Docs after it arrives, and these numbers tell them apart.
      log.info('docs_image_staged', {
        workId: asset.workId,
        pngWidth: size.width,
        pngHeight: size.height,
        widthPt: placement.widthPt,
        heightPt: placement.heightPt,
        dpi: Math.round(size.width / (placement.widthPt / 72)),
      })
      images.push({ workId: asset.workId, title: asset.title, uri: fileContentUrl(fileId), ...placement })
    }
    const blocks = compileDocsBlocks(markdown, images)

    // Clearing the body leaves its first section, and a previous publish may
    // have made that a landscape figure page; it starts portrait again.
    const existing = appendIndex(await getDocument(accessToken, documentId))
    await batchUpdateDocument(accessToken, documentId, [
      ...(existing > BODY_START ? [{ deleteContentRange: { range: { startIndex: BODY_START, endIndex: existing } } }] : []),
      sectionStyleRequest(BODY_START, 'portrait'),
    ])

    let cursor = BODY_START
    let run: RunBlock[] = []
    const flushRun = async () => {
      if (run.length === 0) return
      const plan = blockRequests(run, cursor)
      await batchUpdateDocument(accessToken, documentId, plan.requests)
      cursor = plan.endIndex
      run = []
    }

    for (const block of blocks) {
      if (block.kind !== 'table') {
        run.push(block)
        continue
      }
      await flushRun()
      const rows = block.rows.length
      const columns = block.rows[0]?.length ?? 0
      if (rows === 0 || columns === 0) continue
      await batchUpdateDocument(accessToken, documentId, [{ insertTable: { location: { index: cursor }, rows, columns } }])
      const inserted = lastTable(await getDocument(accessToken, documentId))
      if (!inserted?.table || inserted.startIndex === undefined) throw new Error('The table could not be placed in the document.')
      const cells = inserted.table.tableRows.map((row) => row.tableCells.map((cell) => ({ startIndex: cell.startIndex ?? 0 })))
      await batchUpdateDocument(accessToken, documentId, tableRequests(block, inserted.startIndex, cells))
      cursor = appendIndex(await getDocument(accessToken, documentId))
    }
    await flushRun()
  } finally {
    for (const fileId of staged) {
      try {
        await deleteFile(accessToken, fileId)
      } catch (error) {
        log.warn('docs_image_cleanup_failed', { fileId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
