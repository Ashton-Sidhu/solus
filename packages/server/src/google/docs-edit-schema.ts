import { z } from 'zod'

const dimension = z.object({ magnitude: z.number().optional(), unit: z.string().optional() })
const color = z.object({ color: z.object({ rgbColor: z.object({ red: z.number().optional(), green: z.number().optional(), blue: z.number().optional() }) }).optional() })
const border = z.object({ width: dimension, padding: dimension.optional(), dashStyle: z.string(), color })
const textStyle = z.object({
  bold: z.boolean().optional(), italic: z.boolean().optional(),
  strikethrough: z.boolean().optional(), underline: z.boolean().optional(),
  weightedFontFamily: z.object({ fontFamily: z.string(), weight: z.number().optional() }).optional(),
  fontSize: dimension.optional(), foregroundColor: color.optional(), backgroundColor: color.optional(),
  link: z.object({ url: z.string() }).strict().optional(), baselineOffset: z.string().optional(),
}).strict()
const paragraph = z.object({
  bullet: z.object({ listId: z.string(), nestingLevel: z.number().optional() }).strict().optional(),
  elements: z.array(z.union([
    z.object({ startIndex: z.number(), endIndex: z.number(), textRun: z.object({ content: z.string(), textStyle: textStyle.optional() }).strict() }).strict(),
    z.object({ startIndex: z.number(), endIndex: z.number(), inlineObjectElement: z.object({ inlineObjectId: z.string(), textStyle: textStyle.optional() }).strict() }).strict(),
  ])),
  paragraphStyle: z.object({
    namedStyleType: z.string().optional(), headingId: z.string().optional(),
    alignment: z.string().optional(), direction: z.string().optional(),
    spaceAbove: dimension.optional(), spaceBelow: dimension.optional(),
    indentStart: dimension.optional(), indentEnd: dimension.optional(), indentFirstLine: dimension.optional(),
    lineSpacing: z.number().optional(), avoidWidowAndOrphan: z.boolean().optional(),
    keepWithNext: z.boolean().optional(), keepTogether: z.boolean().optional(), pageBreakBefore: z.boolean().optional(),
    borderTop: border.optional(), borderBottom: border.optional(), borderLeft: border.optional(), borderRight: border.optional(), borderBetween: border.optional(),
    shading: z.object({ backgroundColor: color }).optional(),
  }).strict().optional(),
}).strict()
const paragraphElement = z.object({ startIndex: z.number(), endIndex: z.number(), paragraph }).strict()
const cell = z.object({
  startIndex: z.number(), endIndex: z.number(), content: z.array(paragraphElement),
  tableCellStyle: z.object({ rowSpan: z.literal(1).optional(), columnSpan: z.literal(1).optional() }).optional(),
}).strict()
const table = z.object({
  startIndex: z.number(), endIndex: z.number(),
  table: z.object({
    rows: z.number(), columns: z.number(),
    tableRows: z.array(z.object({ startIndex: z.number().optional(), endIndex: z.number().optional(), tableCells: z.array(cell), tableRowStyle: z.object({}).optional() }).strict()),
    tableStyle: z.object({}).optional(),
  }).strict(),
}).strict()
export const editableDocumentSchema = z.object({
  revisionId: z.string().min(1),
  tabs: z.array(z.object({
    tabProperties: z.object({ tabId: z.string().min(1) }), childTabs: z.array(z.never()).optional(),
    documentTab: z.object({
      inlineObjects: z.record(z.string(), z.object({ inlineObjectProperties: z.object({ embeddedObject: z.object({ size: z.object({ width: dimension, height: dimension }), imageProperties: z.object({ sourceUri: z.string().optional() }).optional() }) }) })).optional(),
      body: z.object({ content: z.array(z.union([
      z.object({ startIndex: z.number().optional(), endIndex: z.number(), sectionBreak: z.object({}) }).strict(),
      paragraphElement, table,
    ])) }).strict() }),
  })).length(1),
})
export type EditableDocument = z.infer<typeof editableDocumentSchema>
export type EditableTable = z.infer<typeof table>
export type EditableParagraph = z.infer<typeof paragraphElement>
export const UNSUPPORTED_GOOGLE_EDIT = 'This Google Doc update is not supported yet. Solus preserves existing objects and only applies supported changes to paragraphs and table cells. It never replaces the document body. Edit this change in Google Docs.'
