import { appendIndex, batchUpdateDocument, getDocument, type DocsDocument, type DocsStructuralElement } from './docs-api'
import {
  BODY_START,
  blockRequests,
  compileDocsBlocks,
  sectionStyleRequest,
  tableRequests,
  type ParagraphBlock,
} from './docs-requests'

function lastTable(doc: DocsDocument): DocsStructuralElement | null {
  const content = doc.body?.content ?? []
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index].table) return content[index]
  }
  return null
}

/**
 * Populate a newly created, empty Google Doc. Never use this for updates.
 *
 * Paragraphs go up in one batch per run. A table is inserted empty, the
 * document is read back to learn where its cells landed, and the cells are
 * filled; then the run continues from the new end of the body.
 */
export async function writeNewDocsBody(accessToken: string, documentId: string, markdown: string): Promise<void> {
  const initial = await getDocument(accessToken, documentId)
  if (appendIndex(initial) !== BODY_START) throw new Error('Google Doc creation requires an empty document. Existing content is never replaced.')
  const blocks = compileDocsBlocks(markdown)

  await batchUpdateDocument(accessToken, documentId, [sectionStyleRequest(BODY_START)])

  let cursor = BODY_START
  let run: ParagraphBlock[] = []
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
}
