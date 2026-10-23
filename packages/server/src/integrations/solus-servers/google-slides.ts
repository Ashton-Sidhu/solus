import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson } from './solus-server'

/**
 * Google Slides as a Solus MCP server (docs/plans/mcp-integrations.md
 * §13.6): Google publishes no usable Slides MCP server. The tools are the
 * ones agents use most — a deck's text and speaker notes, creating a deck,
 * adding, changing, and deleting slides — over the Slides API v1.
 */

const API = 'https://slides.googleapis.com/v1/presentations'

/** `presentations` reads and writes the user's presentations; Slides has no narrower scope that writes. */
export const GOOGLE_SLIDES_SCOPES = ['https://www.googleapis.com/auth/presentations'] as const

/** The id in a Google Slides URL, or the text as given when it is an id already. */
function fileIdOf(idOrUrl: string): string {
  return /\/presentation\/d\/([\w-]+)/.exec(idOrUrl)?.[1] ?? idOrUrl.trim()
}

const presentation = z.string().min(1).describe('A presentation id, or its Google Slides URL.')

// Only the parts of a deck that carry text: the full answer holds every
// shape's geometry and style and is far larger than a tool result.
const textContentSchema = z.object({
  textElements: z.array(z.object({ textRun: z.object({ content: z.string() }).optional() })).optional(),
}).optional()

const pageElementSchema = z.object({
  objectId: z.string().optional(),
  // Slides' own field name for a box, placeholder, or text frame.
  'shape': z.object({ text: textContentSchema }).optional(),
  table: z.object({
    tableRows: z.array(z.object({ tableCells: z.array(z.object({ text: textContentSchema })).optional() })).optional(),
  }).optional(),
})

const presentationSchema = z.object({
  presentationId: z.string(),
  title: z.string().optional(),
  slides: z.array(z.object({
    objectId: z.string(),
    pageElements: z.array(pageElementSchema).optional(),
    slideProperties: z.object({
      notesPage: z.object({
        notesProperties: z.object({ speakerNotesObjectId: z.string().optional() }).optional(),
        pageElements: z.array(pageElementSchema).optional(),
      }).optional(),
    }).optional(),
  })).optional(),
})

type PageElement = z.output<typeof pageElementSchema>

const TEXT_FIELDS = 'text/textElements/textRun/content'
const ELEMENT_FIELDS = `objectId,shape/${TEXT_FIELDS},table/tableRows/tableCells/${TEXT_FIELDS}`
const PRESENTATION_FIELDS = `presentationId,title,slides(objectId,pageElements(${ELEMENT_FIELDS}),slideProperties/notesPage(notesProperties/speakerNotesObjectId,pageElements(${ELEMENT_FIELDS})))`

function textOf(text: z.output<typeof textContentSchema>): string {
  return (text?.textElements ?? []).map((element) => element.textRun?.content ?? '').join('')
}

/** A shape's text, or a table's cells joined by tabs and rows by newlines. */
function elementText(element: PageElement): string {
  const box = element['shape']
  if (box) return textOf(box.text)
  return (element.table?.tableRows ?? []).map((row) => (row.tableCells ?? []).map((cell) => textOf(cell.text).trim()).join('\t')).join('\n')
}

/** The layouts every Google theme has, and the placeholders the title and body go in. */
const LAYOUTS = ['TITLE_AND_BODY', 'TITLE', 'TITLE_ONLY', 'SECTION_HEADER', 'TITLE_AND_TWO_COLUMNS', 'MAIN_POINT', 'BIG_NUMBER', 'BLANK'] as const
type Layout = (typeof LAYOUTS)[number]

/** The placeholder types a layout puts its title and body in. */
interface LayoutPlaceholders {
  title?: string
  body?: string
}

const LAYOUT_PLACEHOLDERS = {
  TITLE_AND_BODY: { title: 'TITLE', body: 'BODY' },
  TITLE: { title: 'CENTERED_TITLE', body: 'SUBTITLE' },
  TITLE_ONLY: { title: 'TITLE' },
  SECTION_HEADER: { title: 'TITLE' },
  TITLE_AND_TWO_COLUMNS: { title: 'TITLE', body: 'BODY' },
  MAIN_POINT: { title: 'TITLE' },
  BIG_NUMBER: { title: 'TITLE', body: 'BODY' },
  BLANK: {},
} satisfies Record<Layout, LayoutPlaceholders>

/** An object id Slides accepts: 5 to 50 letters, digits, `_`, or `-`. */
function newObjectId(): string {
  return `solus_${randomUUID().replaceAll('-', '')}`
}

interface PlacedText {
  mapping: { layoutPlaceholder: { type: string; index: number }; objectId: string }
  insert: { insertText: { objectId: string; text: string } }
}

/** The placeholder mapping and text insert for a title or body, or an error when the layout has no place for it. */
function placedText(layout: Layout, part: 'title' | 'body', text: string): PlacedText {
  const placeholders: LayoutPlaceholders = LAYOUT_PLACEHOLDERS[layout]
  const type = placeholders[part]
  if (!type) throw new Error(`The ${layout} layout has no ${part}.`)
  const objectId = newObjectId()
  return { mapping: { layoutPlaceholder: { type, index: 0 }, objectId }, insert: { insertText: { objectId, text } } }
}

function batchUpdatePath(id: string): string {
  return `${API}/${encodeURIComponent(fileIdOf(id))}:batchUpdate`
}

export const googleSlidesServer = new GoogleSolusServer({
  id: 'google-slides',
  name: 'Google Slides',
  description: 'Read decks and add, change, and delete slides in Google Slides.',
  domain: 'slides.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png',
  categories: ['productivity'],
  hosts: ['slides.googleapis.com'],
  scopes: GOOGLE_SLIDES_SCOPES,
  tools: [
    solusTool({
      name: 'read_presentation',
      description: 'A presentation\'s title and each slide\'s objectId, position, text, and speaker notes.',
      input: z.object({ presentation }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const answer = presentationSchema.parse(await vendorJson(await fetch(`${API}/${encodeURIComponent(fileIdOf(input.presentation))}?fields=${encodeURIComponent(PRESENTATION_FIELDS)}`)))
        return {
          presentationId: answer.presentationId,
          title: answer.title ?? '',
          slides: (answer.slides ?? []).map((slide, index) => {
            const notesPage = slide.slideProperties?.notesPage
            // The notes page also holds a picture of the slide; only the speaker notes shape is the notes.
            const notesId = notesPage?.notesProperties?.speakerNotesObjectId
            const notes = notesPage?.pageElements?.find((element) => element.objectId === notesId)
            return {
              objectId: slide.objectId,
              index,
              text: (slide.pageElements ?? []).map(elementText).map((text) => text.trim()).filter(Boolean).join('\n'),
              notes: notes ? elementText(notes).trim() : '',
            }
          }),
        }
      },
    }),
    solusTool({
      name: 'create_presentation',
      description: 'Create a presentation in the user\'s Drive. It starts with one title slide.',
      input: z.object({ title: z.string().min(1) }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${API}?fields=presentationId,title`, { method: 'POST', body: JSON.stringify({ title: input.title }) })),
    }),
    solusTool({
      name: 'add_slide',
      description: 'Add a slide with one of the theme\'s standard layouts, and optionally its title and body text. The answer has the new slide\'s objectId.',
      input: z.object({
        presentation,
        layout: z.enum(LAYOUTS).default('TITLE_AND_BODY'),
        title: z.string().optional(),
        body: z.string().optional().describe('The body text; for the TITLE layout, the subtitle. Separate bullet lines with newlines.'),
        insertionIndex: z.number().int().min(0).optional().describe('The zero-based position; at the end when not given.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const placed: PlacedText[] = []
        if (input.title) placed.push(placedText(input.layout, 'title', input.title))
        if (input.body) placed.push(placedText(input.layout, 'body', input.body))
        const createSlide = {
          insertionIndex: input.insertionIndex,
          slideLayoutReference: { predefinedLayout: input.layout },
          placeholderIdMappings: placed.map((part) => part.mapping),
        }
        return vendorJson(await fetch(batchUpdatePath(input.presentation), {
          method: 'POST',
          body: JSON.stringify({ requests: [{ createSlide }, ...placed.map((part) => part.insert)] }),
        }))
      },
    }),
    solusTool({
      name: 'replace_text',
      description: 'Replace every match of some text in the presentation, or only on the given slides. The answer has how many were changed.',
      input: z.object({
        presentation,
        find: z.string().min(1),
        replaceWith: z.string(),
        matchCase: z.boolean().default(true),
        slideIds: z.array(z.string().min(1)).optional().describe('Slide objectIds from read_presentation; every slide when not given.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(batchUpdatePath(input.presentation), {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            replaceAllText: { containsText: { text: input.find, matchCase: input.matchCase }, replaceText: input.replaceWith, pageObjectIds: input.slideIds },
          }],
        }),
      })),
    }),
    solusTool({
      name: 'delete_slide',
      description: 'Delete a slide and everything on it.',
      input: z.object({ presentation, slideId: z.string().min(1).describe('The slide\'s objectId from read_presentation.') }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        await vendorJson(await fetch(batchUpdatePath(input.presentation), {
          method: 'POST',
          body: JSON.stringify({ requests: [{ deleteObject: { objectId: input.slideId } }] }),
        }))
        return { deleted: input.slideId }
      },
    }),
  ],
})
