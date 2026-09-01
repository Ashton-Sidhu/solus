import type {
  BrowserAnnotation,
  BrowserAnnotationState,
  BrowserPage,
} from '@solus/contracts/browser-types'
import { snapshotViewportLabel } from '@solus/contracts/browser-types'

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
    lines.push('', 'Marks, numbered as they appear in the image:')
    annotations.forEach((annotation, index) => lines.push(annotationLine(annotation, index)))
  }

  return lines.join('\n')
}
