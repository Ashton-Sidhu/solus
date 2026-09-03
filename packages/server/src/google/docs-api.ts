import { z } from 'zod'

/**
 * The Google Docs API, as far as Solus reads and writes it.
 *
 * Drive's HTML and markdown importers restyle a document however they like,
 * and its markdown exporter joins paragraphs with hard breaks, quotes bullets,
 * and bolds headings. The Docs API is the only way to say exactly which
 * paragraph is a heading, which is a bullet, and which is code, and to read
 * the same facts back. It accepts the `drive.file` grant Solus already holds
 * for documents Solus created, and `drive.readonly` for the rest.
 */

const DOCS_URL = 'https://docs.googleapis.com/v1/documents'

// ─── the document, read ───

export interface DocsTextStyle {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  weightedFontFamily?: { fontFamily?: string }
  link?: { url?: string }
}

export interface DocsParagraphElement {
  startIndex?: number
  endIndex?: number
  textRun?: { content: string; textStyle?: DocsTextStyle }
  inlineObjectElement?: { inlineObjectId: string }
}

export interface DocsParagraph {
  elements: DocsParagraphElement[]
  paragraphStyle?: {
    namedStyleType?: string
    indentStart?: { magnitude?: number; unit?: string }
  }
  bullet?: { listId: string; nestingLevel?: number }
}

export interface DocsTableCell {
  startIndex?: number
  endIndex?: number
  content: DocsStructuralElement[]
}

export interface DocsTable {
  rows?: number
  columns?: number
  tableRows: { tableCells: DocsTableCell[] }[]
}

export interface DocsStructuralElement {
  startIndex?: number
  endIndex?: number
  paragraph?: DocsParagraph
  table?: DocsTable
}

export interface DocsList {
  listProperties: { nestingLevels: { glyphType?: string; glyphSymbol?: string }[] }
}

export interface DocsDocument {
  documentId: string
  title?: string
  body?: { content: DocsStructuralElement[] }
  lists?: Record<string, DocsList>
}

const textStyleSchema: z.ZodType<DocsTextStyle> = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  weightedFontFamily: z.object({ fontFamily: z.string().optional() }).optional(),
  link: z.object({ url: z.string().optional() }).optional(),
})

const paragraphSchema: z.ZodType<DocsParagraph> = z.object({
  elements: z.array(z.object({
    startIndex: z.number().optional(),
    endIndex: z.number().optional(),
    textRun: z.object({ content: z.string(), textStyle: textStyleSchema.optional() }).optional(),
    inlineObjectElement: z.object({ inlineObjectId: z.string() }).optional(),
  })),
  paragraphStyle: z.object({
    namedStyleType: z.string().optional(),
    indentStart: z.object({ magnitude: z.number().optional(), unit: z.string().optional() }).optional(),
  }).optional(),
  bullet: z.object({ listId: z.string(), nestingLevel: z.number().optional() }).optional(),
})

const structuralElementSchema: z.ZodType<DocsStructuralElement> = z.lazy(() => z.object({
  startIndex: z.number().optional(),
  endIndex: z.number().optional(),
  paragraph: paragraphSchema.optional(),
  table: z.object({
    rows: z.number().optional(),
    columns: z.number().optional(),
    tableRows: z.array(z.object({
      tableCells: z.array(z.object({
        startIndex: z.number().optional(),
        endIndex: z.number().optional(),
        content: z.array(structuralElementSchema),
      })),
    })),
  }).optional(),
}))

const documentSchema: z.ZodType<DocsDocument> = z.object({
  documentId: z.string(),
  title: z.string().optional(),
  body: z.object({ content: z.array(structuralElementSchema) }).optional(),
  lists: z.record(z.string(), z.object({
    listProperties: z.object({
      nestingLevels: z.array(z.object({ glyphType: z.string().optional(), glyphSymbol: z.string().optional() })),
    }),
  })).optional(),
})

// ─── the requests Solus writes ───

export interface DocsRange {
  startIndex: number
  endIndex: number
}

export interface DocsDimension {
  magnitude: number
  unit: 'PT'
}

export interface DocsColor {
  color: { rgbColor: { red: number; green: number; blue: number } }
}

export interface DocsWrittenTextStyle {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  weightedFontFamily?: { fontFamily: string }
  fontSize?: DocsDimension
  foregroundColor?: DocsColor
  backgroundColor?: DocsColor
  link?: { url: string }
}

export interface DocsParagraphBorder {
  width: DocsDimension
  padding: DocsDimension
  dashStyle: 'SOLID'
  color: DocsColor
}

/** Docs draws adjacent paragraphs with identical borders and indents as one
 *  box: the top and bottom edges appear only at the ends of the run, and
 *  `borderBetween` sits between members. That is what makes a code block. */
export interface DocsWrittenParagraphStyle {
  namedStyleType?: string
  alignment?: 'START' | 'CENTER' | 'END'
  indentStart?: DocsDimension
  indentEnd?: DocsDimension
  indentFirstLine?: DocsDimension
  spaceAbove?: DocsDimension
  spaceBelow?: DocsDimension
  lineSpacing?: number
  shading?: { backgroundColor: DocsColor }
  borderTop?: DocsParagraphBorder
  borderBottom?: DocsParagraphBorder
  borderLeft?: DocsParagraphBorder
  borderRight?: DocsParagraphBorder
  borderBetween?: DocsParagraphBorder
}

export interface DocsTableCellBorder {
  width: DocsDimension
  dashStyle: 'SOLID'
  color: DocsColor
}

export interface DocsWrittenTableCellStyle {
  backgroundColor?: DocsColor
  paddingTop?: DocsDimension
  paddingBottom?: DocsDimension
  paddingLeft?: DocsDimension
  paddingRight?: DocsDimension
  borderTop?: DocsTableCellBorder
  borderBottom?: DocsTableCellBorder
  borderLeft?: DocsTableCellBorder
  borderRight?: DocsTableCellBorder
}

export type DocsBulletPreset = 'BULLET_DISC_CIRCLE_SQUARE' | 'NUMBERED_DECIMAL_ALPHA_ROMAN'

/** Every field is required: the API rejects an update that unsets one. */
export interface DocsWrittenSectionStyle {
  flipPageOrientation: boolean
  marginTop: DocsDimension
  marginBottom: DocsDimension
  marginLeft: DocsDimension
  marginRight: DocsDimension
}

export type DocsRequest =
  | { insertText: { location: { index: number }; text: string } }
  | { insertSectionBreak: { location: { index: number }; sectionType: 'NEXT_PAGE' } }
  | { updateSectionStyle: { range: DocsRange; sectionStyle: DocsWrittenSectionStyle; fields: string } }
  | { deleteContentRange: { range: DocsRange } }
  | { updateTextStyle: { range: DocsRange; textStyle: DocsWrittenTextStyle; fields: string } }
  | { updateParagraphStyle: { range: DocsRange; paragraphStyle: DocsWrittenParagraphStyle; fields: string } }
  | { createParagraphBullets: { range: DocsRange; bulletPreset: DocsBulletPreset } }
  | { insertTable: { location: { index: number }; rows: number; columns: number } }
  | {
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: { tableStartLocation: { index: number }; rowIndex: number; columnIndex: number }
          rowSpan: number
          columnSpan: number
        }
        tableCellStyle: DocsWrittenTableCellStyle
        fields: string
      }
    }
  | {
      updateTableColumnProperties: {
        tableStartLocation: { index: number }
        columnIndices: number[]
        tableColumnProperties: { widthType: 'FIXED_WIDTH'; width: DocsDimension }
        fields: string
      }
    }
  | {
      insertInlineImage: {
        location: { index: number }
        uri: string
        objectSize: { width: DocsDimension; height: DocsDimension }
      }
    }

async function docsFetch(accessToken: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    if (res.status === 403 && body.includes('SERVICE_DISABLED')) {
      throw new Error('The Google Docs API is not enabled for this Solus Google Cloud project.')
    }
    throw new Error(`Google Docs request failed (${res.status}): ${body}`)
  }
  return res
}

export async function getDocument(accessToken: string, documentId: string): Promise<DocsDocument> {
  const res = await docsFetch(accessToken, `${DOCS_URL}/${encodeURIComponent(documentId)}`)
  return documentSchema.parse(await res.json())
}

export async function batchUpdateDocument(
  accessToken: string,
  documentId: string,
  requests: DocsRequest[],
): Promise<void> {
  if (requests.length === 0) return
  await docsFetch(accessToken, `${DOCS_URL}/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  })
}

/** The index a new block is appended at: just before the body's final
 *  newline, which the API never lets anyone delete. */
export function appendIndex(doc: DocsDocument): number {
  const content = doc.body?.content ?? []
  const last = content[content.length - 1]
  return Math.max(1, (last?.endIndex ?? 2) - 1)
}
