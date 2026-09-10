import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { dataDir } from '../platform/paths'
import type { TextEdit } from './docs-edit-plan'
import type { DocsRequest } from './docs-api'

const quoteSchema = z.object({ id: z.string(), original: z.string(), current: z.string() })
const stateSchema = z.object({ fingerprint: z.string(), quotes: z.array(quoteSchema) })
const checkpointSchema = z.object({ states: z.array(stateSchema).max(2) })
type Quote = z.infer<typeof quoteSchema>
interface CommentQuote { id: string; quote: string }
interface QuoteCheckpoint { quotes: string[]; save: (requests: DocsRequest[], structuralEdits?: TextEdit[]) => Promise<void> }

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Google's quotedFileContent is the original quote, even after a successful
 * review edit. Remember our own transformation only against the exact indexed
 * text we saw or planned. An external text change invalidates the mapping.
 * Save both states before sending: a lost response must not lose the mapping. */
export async function commentCheckpoint(documentId: string, tabId: string, text: string, comments: CommentQuote[]): Promise<QuoteCheckpoint> {
  const directory = join(dataDir(), 'google-doc-comment-checkpoints')
  const path = join(directory, fingerprint(documentId + ':' + tabId) + '.json')
  let previous: z.infer<typeof checkpointSchema> | undefined
  try { previous = checkpointSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const currentFingerprint = fingerprint(text)
  const state = previous?.states.find(candidate => candidate.fingerprint === currentFingerprint)
  const quotes: Quote[] = comments.map(comment => {
    const saved = state?.quotes.find(candidate => candidate.id === comment.id && candidate.original === comment.quote)
    return { id: comment.id, original: comment.quote, current: saved?.current ?? comment.quote }
  })
  return {
    quotes: quotes.map(quote => quote.current),
    async save(requests, structuralEdits = []) {
      if ((!requests.length && !structuralEdits.length) || !quotes.length) return
      let after = text
      const ranges = quotes.map(quote => ({ ...quote, start: text.indexOf(quote.current), end: text.indexOf(quote.current) + quote.current.length }))
      const edits = [...structuralEdits]
      for (const request of requests) {
        if ('deleteContentRange' in request) edits.push({ start: request.deleteContentRange.range.startIndex, end: request.deleteContentRange.range.endIndex, text: '' })
        else if ('insertText' in request) edits.push({ start: request.insertText.location.index, end: request.insertText.location.index, text: request.insertText.text })
      }
      for (const edit of edits) {
        const { start, end, text: inserted } = edit
        after = after.slice(0, start) + inserted + after.slice(end)
        const delta = inserted.length - (end - start)
        for (const range of ranges) {
          if (end <= range.start) { range.start += delta; range.end += delta }
          else if (start > range.start && end < range.end) range.end += delta
        }
      }
      const next = ranges.map(range => ({ id: range.id, original: range.original, current: range.start < 0 ? range.current : after.slice(range.start, range.end) }))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = path + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify({ states: [{ fingerprint: currentFingerprint, quotes }, { fingerprint: fingerprint(after), quotes: next }] }), { mode: 0o600 })
        await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
    },
  }
}
