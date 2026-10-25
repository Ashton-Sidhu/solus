import type {
  BrowserAnnotation,
  BrowserAnnotationState,
  BrowserPage,
} from '@solus/contracts/browser-types'
import { snapshotViewportLabel } from '@solus/contracts/browser-types'
import type { BrowserMark } from '@solus/contracts/types'

/** Opens the mark list. The attachment merge and the history reader find it. */
export const MARKS_HEADING = 'Marks, numbered as they appear in the image:'

/**
 * Turn what the user pointed at into something an agent can act on.
 *
 * This is the whole reason the annotation tools exist: a screenshot says "this
 * looks wrong somewhere", and a screenshot plus a numbered mark carrying a file
 * and a line says which component to open. Marks made with `pick` name their
 * Svelte source; a box names every element it collected; freehand names a
 * rectangle, which is still better than prose about "the button near the top".
 *
 * Stable mark numbers keep the comment popup, attachment, and prompt aligned
 * after an earlier mark is removed.
 */

/** How one mark reads. Exported for the test that pins the file:line rule —
 *  the source location is the thing that turns a circle into an edit. */
function elementText(element: NonNullable<BrowserAnnotation['element']>): string {
  const { role, label, identifier, source } = element
  const parts = [`<${role}>`]
  if (label) parts.push(`"${label}"`)
  if (identifier) parts.push(`#${identifier}`)
  if (source) parts.push(`— ${source.file}:${source.line}`)
  return parts.join(' ')
}

export function annotationLine(annotation: BrowserAnnotation, index: number): string {
  // The mark's own stable number when it has one, so the line matches the
  // comment and attachment after an earlier mark was removed; the position is
  // only the fallback for a mark from an older read.
  const parts = [`${annotation.number ?? index + 1}.`]
  if (annotation.element) {
    parts.push(elementText(annotation.element))
  } else if (annotation.elements?.length) {
    const { x, y, width, height } = annotation.rect
    parts.push(
      `box selected ${annotation.elements.length} ${annotation.elements.length === 1 ? 'element' : 'elements'}`,
      `in ${width}×${height} at ${x},${y}:`,
      annotation.elements.map(elementText).join('; '),
    )
  } else {
    const { x, y, width, height } = annotation.rect
    parts.push(annotation.tool === 'draw' ? 'drawn around' : 'region')
    parts.push(`${width}×${height} at ${x},${y}`)
  }
  // Last, because the user's own words are what the agent should weigh most,
  // and a reader stops at the end of the line.
  // One mark is one line: a chip removed from the composer takes its line with
  // it, and that only stays exact while a note cannot open a second line.
  if (annotation.note) parts.push(`— ${annotation.note.replace(/\s+/g, ' ').trim()}`)
  return parts.join(' ')
}

export interface AnnotationPromptInput {
  page: BrowserPage
  state: BrowserAnnotationState
  /** The capture taken with the marks up, as a host asset id. Absent when the
   *  capture failed — the words are still worth sending. */
  assetId?: string | undefined
}

/**
 * The message the user sends.
 *
 * Markdown, because it lands in the composer as a normal prompt and the asset
 * link renders as the image the agent and the user both look at. Returns null
 * when there is nothing to say, so an empty annotation set cannot produce a
 * message that only wastes a turn.
 */
export function composeAnnotationPrompt(input: AnnotationPromptInput): string | null {
  const { annotations } = input.state
  if (!annotations.length) return null

  const lines: string[] = []
  if (input.assetId) lines.push(`![annotated browser](asset://${input.assetId})`, '')
  lines.push(
    `I marked up ${input.page.url} at ${snapshotViewportLabel(input.page.viewport)}`
    + `${input.page.appearance === 'system' ? '' : ` in ${input.page.appearance} mode`}.`,
  )

  if (annotations.length) {
    lines.push('', MARKS_HEADING)
    annotations.forEach((annotation, index) => lines.push(annotationLine(annotation, index)))
  }

  return lines.join('\n')
}

/** What a sent annotation still says once only its words are left. */
export interface ReadAnnotation {
  pageURL: string
  viewport: { width: number; height: number }
  appearance?: 'light' | 'dark'
  marks: BrowserMark[]
}

const MARKED_UP_LINE = /^I marked up (\S+) at .+ — (\d+)×(\d+)(?: in (light|dark) mode)?\.$/
const MARK_LINE = /^(\d+)\. (.*)$/
const BOX_HEAD = /^box selected (\d+) elements? in (\d+)×(\d+) at (-?\d+),(-?\d+): /
const SHAPE_HEAD = /^(region|drawn around) (\d+)×(\d+) at (-?\d+),(-?\d+)/
const SOURCE = /^ — \S+:\d+(?=$|; | — )/

/** One `elementText`, read from the start of `text`. Returns what a chip names
 *  it by (the same form `markSelector` writes) and the text after it. */
function readElement(text: string): { selector: string; identifier?: string; rest: string } | null {
  const role = /^<([^>]+)>/.exec(text)
  if (!role) return null
  let rest = text.slice(role[0].length)
  let label: string | undefined
  if (rest.startsWith(' "')) {
    // A label may hold a quote; it closes at the quote the next part follows.
    const end = /"(?=$| #| — |; )/.exec(rest.slice(2))
    if (!end) return null
    label = rest.slice(2, 2 + end.index)
    rest = rest.slice(2 + end.index + 1)
  }
  const identifier = /^ #(\S+)/.exec(rest)
  if (identifier) rest = rest.slice(identifier[0].length)
  const source = SOURCE.exec(rest)
  if (source) rest = rest.slice(source[0].length)
  const selector = identifier
    ? `${role[1]}#${identifier[1]}`
    : label ? `${role[1]} · ${label}` : role[1]!
  return { selector, identifier: identifier?.[1], rest }
}

/** The note `annotationLine` puts last, or undefined when `rest` is not one. */
function readNote(rest: string): string | undefined | null {
  if (!rest) return undefined
  return rest.startsWith(' — ') ? rest.slice(3) : null
}

function readMark(line: string): BrowserMark | null {
  const numbered = MARK_LINE.exec(line)
  if (!numbered) return null
  const pin = Number(numbered[1])
  const body = numbered[2]!
  const mark = { id: `history-mark-${pin}`, pin }

  const box = BOX_HEAD.exec(body)
  if (box) {
    let rest = body.slice(box[0].length)
    let selector: string | undefined
    for (let i = 0; i < Number(box[1]); i++) {
      if (i > 0) {
        if (!rest.startsWith('; ')) return null
        rest = rest.slice(2)
      }
      const element = readElement(rest)
      if (!element) return null
      selector ??= element.selector
      rest = element.rest
    }
    const note = readNote(rest)
    if (note === null) return null
    const [, , width, height, x, y] = box.map(Number)
    return { ...mark, tool: 'region', selector, note, rect: { x: x!, y: y!, width: width!, height: height! } }
  }

  const shape = SHAPE_HEAD.exec(body)
  if (shape) {
    const note = readNote(body.slice(shape[0].length))
    if (note === null) return null
    const [, , width, height, x, y] = shape.map(Number)
    return { ...mark, tool: shape[1] === 'region' ? 'region' : 'draw', note, rect: { x: x!, y: y!, width: width!, height: height! } }
  }

  const element = readElement(body)
  if (!element) return null
  const note = readNote(element.rest)
  if (note === null) return null
  return { ...mark, tool: 'pick', selector: element.selector, identifier: element.identifier, note }
}

/**
 * Read back what `composeAnnotationPrompt` wrote. Provider history keeps a
 * sent annotation only as these words, so a reloaded turn rebuilds its chips
 * from them. Returns null for text this module did not write.
 */
export function readAnnotationPrompt(lines: string[]): ReadAnnotation | null {
  const [first, blank, heading, ...markLines] = lines
  const page = MARKED_UP_LINE.exec(first ?? '')
  if (!page || blank !== '' || heading !== MARKS_HEADING || !markLines.length) return null
  const marks: BrowserMark[] = []
  for (const line of markLines) {
    const mark = readMark(line)
    if (!mark) return null
    marks.push(mark)
  }
  return {
    pageURL: page[1]!,
    viewport: { width: Number(page[2]), height: Number(page[3]) },
    appearance: page[4] as ReadAnnotation['appearance'],
    marks,
  }
}
