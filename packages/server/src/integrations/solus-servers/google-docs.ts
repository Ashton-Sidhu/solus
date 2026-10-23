import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson, type SolusToolContext } from './solus-server'

/**
 * Google Docs as a Solus MCP server (docs/plans/mcp-integrations.md §13.6):
 * reading a document as text, creating one, and changing its text over the
 * Docs API v1. Finding a document belongs to the Google Drive server.
 */

const API = 'https://docs.googleapis.com/v1/documents'

export const GOOGLE_DOCS_SCOPES = ['https://www.googleapis.com/auth/documents'] as const

/** The document id inside a Docs link; any other value is taken as an id. */
function fileIdOf(value: string): string {
  return /\/d\/([\w-]+)/.exec(value)?.[1] ?? value
}

const documentId = z.string().min(1).transform(fileIdOf).describe('A document id, or a Google Docs link to the document.')

/** Only the text and heading styles, so a large document stays small. */
const READ_FIELDS = 'documentId,title,body(content(paragraph(elements/textRun/content,paragraphStyle/namedStyleType),table/tableRows/tableCells/content/paragraph/elements/textRun/content))'

const paragraphSchema = z.object({
  elements: z.array(z.object({ textRun: z.object({ content: z.string().default('') }).optional() })).default([]),
  paragraphStyle: z.object({ namedStyleType: z.string().optional() }).optional(),
})
type Paragraph = z.output<typeof paragraphSchema>

/** A table cell's paragraphs; a table inside a cell is not read. */
const tableSchema = z.object({
  tableRows: z.array(z.object({
    tableCells: z.array(z.object({ content: z.array(z.object({ paragraph: paragraphSchema.optional() })).default([]) })).default([]),
  })).default([]),
})

const documentSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  body: z.object({
    content: z.array(z.object({ paragraph: paragraphSchema.optional(), table: tableSchema.optional() })).default([]),
  }).default({ content: [] }),
})

const createdSchema = z.object({ documentId: z.string(), title: z.string() })

const replaceRepliesSchema = z.object({
  replies: z.array(z.object({ replaceAllText: z.object({ occurrencesChanged: z.number().default(0) }).optional() })).default([]),
})

function paragraphText(paragraph: Paragraph): string {
  return paragraph.elements.map((element) => element.textRun?.content ?? '').join('')
}

/** HEADING_1 to HEADING_6 read as Markdown headings. */
function headingPrefix(paragraph: Paragraph): string {
  const level = /^HEADING_([1-6])$/.exec(paragraph.paragraphStyle?.namedStyleType ?? '')?.[1]
  return level ? `${'#'.repeat(Number(level))} ` : ''
}

/** The body as plain text: headings marked, each table row as one tab-separated line. */
function documentText(document: z.output<typeof documentSchema>): string {
  return document.body.content.map((element) => {
    if (element.paragraph) return `${headingPrefix(element.paragraph)}${paragraphText(element.paragraph)}`
    if (!element.table) return ''
    const rows = element.table.tableRows.map((row) => row.tableCells
      .map((cell) => cell.content.map((part) => part.paragraph ? paragraphText(part.paragraph) : '').join('').replaceAll('\n', ' ').trim())
      .join('\t'))
    return `${rows.join('\n')}\n`
  }).join('')
}

/** Runs edits on one document; a batch applies all or none. */
/** The Docs `batchUpdate` requests these tools send: text inserted at a place, or every match replaced. */
type DocsRequest =
  | { insertText: { text: string; location: { index: number } } }
  | { insertText: { text: string; endOfSegmentLocation: Record<string, never> } }
  | { replaceAllText: { containsText: { text: string; matchCase: boolean }; replaceText: string } }

async function batchUpdate(fetch: SolusToolContext['fetch'], id: string, requests: DocsRequest[]) {
  return vendorJson(await fetch(`${API}/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) }))
}

export const googleDocsServer = new GoogleSolusServer({
  id: 'google-docs',
  name: 'Google Docs',
  description: 'Read, create, and edit the text of Google Docs.',
  domain: 'docs.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png',
  categories: ['knowledge'],
  hosts: ['docs.googleapis.com'],
  scopes: GOOGLE_DOCS_SCOPES,
  tools: [
    solusTool({
      name: 'read_document',
      description: 'A document\'s title and text. Headings start with #, and each table row is one tab-separated line. Only the first tab of a document with tabs is read.',
      input: z.object({ documentId }),
      readOnly: true,
      destructive: false,
      run: async ({ documentId: id }, { fetch }) => {
        const document = documentSchema.parse(await vendorJson(await fetch(`${API}/${encodeURIComponent(id)}?fields=${encodeURIComponent(READ_FIELDS)}`)))
        return { documentId: document.documentId, title: document.title, text: documentText(document) }
      },
    }),
    solusTool({
      name: 'create_document',
      description: 'Create a document in the user\'s My Drive, with optional first text.',
      input: z.object({
        title: z.string().min(1),
        text: z.string().optional().describe('Plain text to start the document with.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const created = createdSchema.parse(await vendorJson(await fetch(API, { method: 'POST', body: JSON.stringify({ title: input.title }) })))
        // A new document's body starts at index 1.
        if (input.text) await batchUpdate(fetch, created.documentId, [{ insertText: { location: { index: 1 }, text: input.text } }])
        return { documentId: created.documentId, title: created.title, url: `https://docs.google.com/document/d/${created.documentId}/edit` }
      },
    }),
    solusTool({
      name: 'append_text',
      description: 'Add plain text at the end of a document. Start the text with a new line to begin a new paragraph.',
      input: z.object({ documentId, text: z.string().min(1) }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        // The end of the body segment, so no index read can go stale before the write.
        await batchUpdate(fetch, input.documentId, [{ insertText: { endOfSegmentLocation: {}, text: input.text } }])
        return { documentId: input.documentId, appended: input.text.length }
      },
    }),
    solusTool({
      name: 'replace_text',
      description: 'Replace every match of a text in a document with another text. It changes all matches at once, not only the first.',
      input: z.object({
        documentId,
        find: z.string().min(1).describe('The text to find.'),
        replaceWith: z.string().describe('The new text; empty removes the matches.'),
        matchCase: z.boolean().default(true),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const answer = replaceRepliesSchema.parse(await batchUpdate(fetch, input.documentId, [{
          replaceAllText: { containsText: { text: input.find, matchCase: input.matchCase }, replaceText: input.replaceWith },
        }]))
        return { documentId: input.documentId, occurrencesChanged: answer.replies[0]?.replaceAllText?.occurrencesChanged ?? 0 }
      },
    }),
    solusTool({
      name: 'insert_text',
      description: 'Advanced: insert plain text at one index of the document body. Index 1 is the start; an index must be inside an existing paragraph. Prefer append_text or replace_text.',
      input: z.object({
        documentId,
        index: z.number().int().min(1).describe('The UTF-16 index to insert at.'),
        text: z.string().min(1),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        await batchUpdate(fetch, input.documentId, [{ insertText: { location: { index: input.index }, text: input.text } }])
        return { documentId: input.documentId, index: input.index, inserted: input.text.length }
      },
    }),
  ],
})
